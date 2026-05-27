/**
 * Task pane entry. Runs inside the Outlook host (web, desktop, mobile).
 *
 * Lifecycle:
 *   1. Office.onReady fires once the host has injected the mailbox context.
 *   2. Pre-fill the form from the currently-open message
 *      (subject, from-address, from-name, body — both text + HTML).
 *      Run a local forwarded-sender disambiguation so the displayed
 *      Client email is the *external* prospect, not the teammate who
 *      forwarded the email to the rep.
 *   3. Call /opportunities/preview-from-email to get the server's
 *      authoritative sender + structured key/value fields extracted from
 *      any HTML tables in the body (RFPs are typically questionnaires).
 *      Templates are loaded lazily — only when the rep opens the
 *      "Send a follow-up link too…" disclosure — because the common
 *      case (capture the email as an opportunity, no follow-up link)
 *      doesn't need one.
 *   4. On submit, POST to /api/v1/opportunities/from-email-ingest. This
 *      routes through the direct-ingest pipeline so the email body
 *      becomes a first-class artifact and extraction runs over it. The
 *      endpoint is idempotent on the email's Message-Id, so accidental
 *      double-clicks don't create duplicates.
 *   5. If the rep opened the link disclosure and chose a template, fire
 *      a follow-up POST to /opportunities/:id/links to attach the
 *      template + mint a gathering token. Two-step because the create
 *      and the link-issue are separable concerns (rep may want to
 *      capture the opportunity now, decide on a template later).
 *
 * What we deliberately don't do:
 *   - Render attachments as separate uploads. The MVP only carries the
 *     email body; attachments are a v2 feature (would need a separate
 *     attachment-upload route on the API and Office.js getAttachmentContentAsync).
 *   - Maintain our own draft state. If the user closes the pane mid-fill,
 *     the next open reads fresh from the (still-open) email — simpler than
 *     persisting drafts and matching the Outlook idiom.
 */

// Build-time configuration. Vite inlines import.meta.env.* at compile time;
// production builds set these via the addin Dockerfile's --mode flag.
//
// RHUD_API: where the task pane sends API calls. Points at rhud.net
// (the API's actual host); the API explicitly allows addin.rhud.net via
// CORS so these cross-origin fetches succeed.
//
// RHUD_WEB: used only for the post-create "Open in Rhud" success link.
//
// ADDIN_ORIGIN: must match the manifest's SourceLocation host exactly.
// Used as the dialog URL for sign-in because Office.context.ui.
// displayDialogAsync enforces strict same-origin (different subdomain
// = different origin = rejected). The outer Caddy proxies /login and
// related auth paths from addin.rhud.net to the same web container that
// serves them on rhud.net, so the dialog gets the real login UI with
// no code duplication.
const RHUD_API = import.meta.env.VITE_RHUD_API ?? 'https://rhud.net';
const RHUD_WEB = import.meta.env.VITE_RHUD_WEB ?? 'https://rhud.net';
const ADDIN_ORIGIN = import.meta.env.VITE_ADDIN_ORIGIN ?? 'https://addin.rhud.net';

const TOKEN_KEY = 'rhud_addin_token';
const USER_KEY = 'rhud_addin_user';

interface TemplateListItem {
  id: string;
  name: string;
  status: 'draft' | 'published' | 'archived';
}

interface CreateFromEmailIngestResponse {
  engagementId: string;
  artifactIds: string[];
}

/** Returned by both the link-share create endpoint and the follow-up
 *  /opportunities/:id/links call. Carries the plaintext token (shown
 *  ONCE — the server stores the hash). */
interface IssuedLinkResponse {
  engagementId: string;
  token: string;
  url: string;
  expiresAt: string;
}

interface CachedAuth {
  token: string;
  user: { sub: string; tid: string; role: string; email: string };
}

interface PreviewResponse {
  parsedSender: { email: string; name?: string } | null;
  isForwarded: boolean;
  structuredFields: Array<{ label: string; value: string }>;
}

/** Holds the most recently extracted email body. Populated by
 *  prefillFromMessage; consumed by loadPreview + submitForm so we don't
 *  re-read from Office.js twice. */
interface MessageBodies {
  text: string;
  html: string;
}

Office.onReady(async (info) => {
  if (info.host !== Office.HostType.Outlook) {
    setStatus('This add-in only runs inside Outlook.', 'error');
    return;
  }
  const item = Office.context.mailbox.item;
  if (!item || item.itemType !== Office.MailboxEnums.ItemType.Message) {
    setStatus('Open an email message to create an opportunity.', 'error');
    return;
  }

  // Read auth first because the disambiguator needs to know "who is the
  // tenant user" to decide what counts as internal. If we have no
  // cached auth the prefill still runs (so the form looks alive) but
  // skips disambiguation — the server will redo it after sign-in.
  const cached = readCachedAuth();
  const bodies = await prefillFromMessage(item, cached?.user.email ?? null);

  // Wire up the form's submit + sign-out handlers regardless of auth
  // state — they're idempotent and need to be ready by the time the
  // user clicks them after sign-in.
  document.getElementById('opportunity-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitForm(item, bodies);
  });
  document.getElementById('signout')!.addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    showSignInPrompt();
    setStatus('Signed out.', 'success');
  });

  // Auth gate. If we already have a token, show the form and kick off
  // the preview. If not, show a "Sign in" button — clicking it (a real
  // user gesture) is what's allowed to open the Office dialog. Auto-
  // opening the dialog from onReady would be treated as an unsolicited
  // popup and blocked by the browser.
  //
  // Note: templates are NOT loaded here. They're only needed when the
  // rep opens the "Send a follow-up link too…" disclosure, so we lazy-
  // load on the disclosure's first toggle. Keeps pane load fast for the
  // common "just create the opportunity" case.
  if (cached) {
    showForm();
    void loadPreview(cached.token, bodies);
  } else {
    showSignInPrompt();
  }

  document.getElementById('signin')!.addEventListener('click', async () => {
    try {
      const auth = await getOrAuthRhudJwt();
      showForm();
      void loadPreview(auth.token, bodies);
    } catch (err) {
      setStatus(`Sign-in failed: ${(err as Error).message}`, 'error');
    }
  });

  // Lazy-load templates the first time the rep opens the disclosure.
  // toggle fires for both open and close — we cache the in-flight
  // promise so that:
  //   - A rapid open → close → open while the fetch is in flight
  //     awaits the SAME promise instead of starting a second request
  //     and racing the previous flag-set (the old `templatesLoaded`
  //     boolean had this race — set-before-await meant a second open
  //     during the await would silently skip the load).
  //   - On failure we drop the cached promise so the next open
  //     retries — likely just an expired token or transient blip.
  let templatesPromise: Promise<void> | null = null;
  document.getElementById('link-disclosure')!.addEventListener('toggle', () => {
    const details = document.getElementById('link-disclosure') as HTMLDetailsElement;
    if (!details.open || templatesPromise) return;
    templatesPromise = (async () => {
      const auth = await getOrAuthRhudJwt();
      await loadTemplates(auth.token);
    })().catch((err: unknown) => {
      templatesPromise = null;
      setStatus(`Couldn't load templates: ${(err as Error).message}`, 'error');
    });
  });
});

function showSignInPrompt(): void {
  document.getElementById('signin-prompt')!.hidden = false;
  document.getElementById('opportunity-form')!.hidden = true;
}

function showForm(): void {
  document.getElementById('signin-prompt')!.hidden = true;
  document.getElementById('opportunity-form')!.hidden = false;
}

/**
 * Prefill the panel from the open Outlook message and return both body
 * representations. We read text + HTML in parallel — text is what the
 * sender disambiguator runs on (regex over `From:` lines is stable
 * across Outlook hosts), HTML is what the server parses for tables.
 *
 * When `tenantUserEmail` is provided, we additionally walk the body's
 * forwarded thread headers; if the apparent sender is internal and an
 * external sender exists upstream, we rewrite the Client email field
 * before the server even sees the message. The server confirms the
 * same answer in loadPreview — this is just a fast-feedback layer.
 */
async function prefillFromMessage(
  item: Office.MessageRead,
  tenantUserEmail: string | null,
): Promise<MessageBodies> {
  setInput('subject', item.subject ?? '');
  const apparentEmail = item.from?.emailAddress ?? '';
  const apparentName = item.from?.displayName ?? '';
  setInput('fromEmail', apparentEmail);
  setInput('fromName', apparentName);

  const [text, html] = await Promise.all([
    readBody(item, Office.CoercionType.Text),
    readBody(item, Office.CoercionType.Html),
  ]);

  // Keep the body textarea populated as a fallback view — the server
  // preview may return structured fields that take its place, but
  // we render this immediately so the pane isn't empty mid-load.
  const ta = document.getElementById('body') as HTMLTextAreaElement;
  ta.value = text.slice(0, 2000);
  ta.dataset.full = text;

  // Local disambiguation — instantaneous so the rep sees the right
  // email *before* the server preview round-trip. Skipped when we
  // don't yet know who the tenant user is.
  if (tenantUserEmail) {
    const resolved = disambiguateForwardedSender({
      sender: { email: apparentEmail, name: apparentName },
      tenantUserEmail,
      bodyText: text,
    });
    if (resolved) {
      setInput('fromEmail', resolved.email);
      setInput('fromName', resolved.name ?? '');
      showForwardedHint(apparentEmail);
    }
  }

  return { text, html };
}

function readBody(item: Office.MessageRead, type: Office.CoercionType): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    item.body.getAsync(type, (r) => {
      if (r.status === Office.AsyncResultStatus.Succeeded) resolve(r.value);
      else reject(new Error(r.error.message));
    });
  });
}

async function loadTemplates(jwt: string): Promise<void> {
  const select = document.getElementById('templateId') as HTMLSelectElement;
  const res = await fetch(`${RHUD_API}/api/v1/templates`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    select.innerHTML = '<option value="">Failed to load templates</option>';
    return;
  }
  const all = (await res.json()) as TemplateListItem[];
  // Filter client-side because the API doesn't currently support
  // ?status=published. Cheap — tenants rarely have more than a few dozen.
  const published = all.filter((t) => t.status === 'published');
  if (published.length === 0) {
    // Empty state is NOT an error any more — templates are now only
    // needed for the optional follow-up link. The rep can still create
    // the opportunity from the email body without one.
    select.innerHTML = '<option value="">No published templates — create the opportunity without a link</option>';
    return;
  }
  // First option is the "no link" choice so the rep can open the
  // disclosure to see what templates exist without committing to
  // sending one. Submitting with this selected = no follow-up call.
  const opts = [`<option value="">— Don't send a link —</option>`];
  for (const t of published) {
    opts.push(`<option value="${t.id}">${escapeHtml(t.name)}</option>`);
  }
  select.innerHTML = opts.join('');
}

/**
 * Fetch the server's preview of this email. The server is authoritative
 * — its sender disambiguation uses the same algorithm as the client but
 * its table extractor runs over the full HTML (we don't ship a parser
 * here). Failures are non-fatal: the form still works with whatever the
 * local prefill produced.
 */
async function loadPreview(jwt: string, bodies: MessageBodies): Promise<void> {
  try {
    const res = await fetch(`${RHUD_API}/api/v1/opportunities/preview-from-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        fromEmail: val('fromEmail'),
        fromName: val('fromName') || undefined,
        subject: val('subject'),
        bodyText: bodies.text,
        // Cap HTML at ~180K to stay safely below the server's 200K DTO
        // limit. Beyond that the email is almost certainly inline images
        // anyway and the table parser won't find anything useful.
        bodyHtml: bodies.html.slice(0, 180_000),
      }),
    });
    if (!res.ok) {
      // Don't surface as an error — this is enrichment, not load-blocking.
      // The user can still create the opportunity with the basic prefill.
      return;
    }
    const data = (await res.json()) as PreviewResponse;
    // Server's answer wins over the local disambiguation. If the rep
    // already manually edited the Client email field they'd be undone,
    // but in practice loadPreview races loadTemplates and resolves
    // before the rep can click anything.
    if (data.parsedSender) {
      setInput('fromEmail', data.parsedSender.email);
      if (data.parsedSender.name) setInput('fromName', data.parsedSender.name);
      showForwardedHint(); // text is informational; original sender already known
    }
    renderStructuredFields(data.structuredFields);
  } catch {
    // Network issue — silently leave the fallback prefill in place.
  }
}

/**
 * Render the structured key/value rows in the panel. When the list is
 * empty, hide the structured-fields block and keep the body textarea
 * visible as the fallback view. When it's non-empty, the textarea is
 * collapsed since the structured view is strictly more useful.
 */
function renderStructuredFields(fields: Array<{ label: string; value: string }>): void {
  const wrap = document.getElementById('structured-wrap') as HTMLElement;
  const bodyWrap = document.getElementById('body-wrap') as HTMLElement;
  const container = document.getElementById('structured-fields')!;
  const count = document.getElementById('structured-count')!;
  if (fields.length === 0) {
    wrap.hidden = true;
    bodyWrap.hidden = false;
    return;
  }
  wrap.hidden = false;
  bodyWrap.hidden = true;
  count.textContent = `${fields.length}`;
  count.className = 'field-hint hint-accent';
  container.innerHTML = `
    <table>
      <tbody>
        ${fields
          .map((f) => {
            const value = f.value.trim();
            const cellClass = value.length === 0 || value === '-' ? 'empty' : '';
            const display = value.length === 0 ? '—' : value;
            return `<tr>
              <th>${escapeHtml(f.label)}</th>
              <td${cellClass ? ` class="${cellClass}"` : ''}>${escapeHtml(display)}</td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>
  `;
}

/** Show a small "Forwarded thread" pill next to the Client email field
 *  so the rep knows we rewrote the value out from under them. */
function showForwardedHint(originalEmail?: string): void {
  const hint = document.getElementById('fromEmail-hint')!;
  hint.hidden = false;
  hint.className = 'field-hint hint-accent';
  hint.textContent = originalEmail
    ? `forwarded by ${originalEmail}`
    : 'from forwarded thread';
}

async function submitForm(item: Office.MessageRead, bodies: MessageBodies): Promise<void> {
  const submitBtn = document.getElementById('create') as HTMLButtonElement;
  submitBtn.disabled = true;
  setStatus('Creating opportunity…');

  // Determine whether to mint a follow-up gathering link in the same
  // submit. Two conditions must both hold:
  //   1. The "Send a follow-up link too…" disclosure is open (an
  //      explicit user action — opening it is the rep saying "yes, I
  //      want to do this").
  //   2. A template is actually selected. The dropdown's first option
  //      is "Don't send a link", which leaves val('templateId') empty
  //      — letting the rep open the disclosure to *look* at templates
  //      without committing.
  const linkDisclosure = document.getElementById('link-disclosure') as HTMLDetailsElement;
  const templateId = val('templateId');
  const wantsLink = linkDisclosure.open && templateId.length > 0;

  try {
    const auth = await getOrAuthRhudJwt();

    // internetMessageId is the RFC822 Message-Id (e.g. "<abc@host>"). Used
    // server-side for idempotency. If Outlook can't give us one (rare —
    // drafts before send), fall back to a synthetic id based on subject +
    // from + a timestamp so retries within the same session still dedup.
    const messageId = item.internetMessageId
      ?? `synthetic-${val('fromEmail')}-${val('subject')}-${Date.now()}`;

    // Step 1: always go through the ingestion path to create the
    // opportunity. No template needed — the email body becomes the
    // first-class artifact, extraction runs over it, and the rep can
    // attach a template later if step 2 didn't happen now.
    const createBody = {
      fromEmail: val('fromEmail'),
      fromName: val('fromName') || undefined,
      clientNameOverride: val('clientNameOverride') || undefined,
      subject: val('subject'),
      bodyText: bodies.text,
      messageId,
      source: 'outlook' as const,
    };

    const createRes = await fetch(`${RHUD_API}/api/v1/opportunities/from-email-ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify(createBody),
    });

    if (createRes.status === 401) {
      // Token expired. Clear cache and prompt re-auth.
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      setStatus('Session expired. Click Create again to sign back in.', 'error');
      return;
    }
    if (!createRes.ok) {
      const err = await createRes.text();
      setStatus(`Create failed (${createRes.status}): ${err.slice(0, 200)}`, 'error');
      return;
    }

    const createData = (await createRes.json()) as CreateFromEmailIngestResponse;
    const oppUrl = `${RHUD_WEB}/opportunities/${createData.engagementId}`;

    // Step 2 (optional): mint the follow-up gathering link. If this
    // fails the opportunity is still created — we surface the partial
    // success rather than rolling anything back. The rep can retry
    // the link mint from the opportunity detail page.
    if (wantsLink) {
      setStatus('Created. Minting gathering link…');
      const linkRes = await fetch(
        `${RHUD_API}/api/v1/opportunities/${createData.engagementId}/links`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${auth.token}`,
          },
          body: JSON.stringify({ templateId }),
        },
      );
      if (linkRes.ok) {
        const linkData = (await linkRes.json()) as IssuedLinkResponse;
        setStatus(
          `Created with link. <a href="${oppUrl}" target="_blank" rel="noopener">Open in Rhud →</a> · ` +
          `<a href="${linkData.url}" target="_blank" rel="noopener">Copy gathering link →</a>`,
          'success',
          true,
        );
        return;
      }
      // Partial success — opportunity created but link mint failed.
      const err = await linkRes.text();
      setStatus(
        `Created, but link mint failed (${linkRes.status}). ` +
          `<a href="${oppUrl}" target="_blank" rel="noopener">Open in Rhud →</a> to retry. ${escapeHtml(err.slice(0, 120))}`,
        'error',
        true,
      );
      return;
    }

    setStatus(
      `Created. <a href="${oppUrl}" target="_blank" rel="noopener">Open in Rhud →</a>`,
      'success',
      true,
    );
  } catch (err) {
    setStatus(`Network error: ${(err as Error).message}`, 'error');
  } finally {
    submitBtn.disabled = false;
  }
}

// ── Forwarded-sender disambiguation ───────────────────────────────────
//
// Mirrors apps/api/src/engagements/email-parser.ts → disambiguateForwardedSender.
// Kept inline (not a shared package) because the function is small and the
// server is the canonical authority — this is just a fast-feedback layer
// so the rep doesn't see a stale Client email for the round-trip.

interface ParsedSender {
  email: string;
  name?: string;
}

function disambiguateForwardedSender(args: {
  sender: { email: string; name?: string };
  tenantUserEmail: string;
  bodyText: string;
}): ParsedSender | null {
  const tenantUser = args.tenantUserEmail.toLowerCase();
  const tenantDomain = domainOf(tenantUser);
  const sender = args.sender.email.toLowerCase();
  const isInternal =
    sender === tenantUser ||
    (tenantDomain !== null && domainOf(sender) === tenantDomain);
  if (!isInternal) return null;

  const fromLineRe = /^[ \t]*From:\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = fromLineRe.exec(args.bodyText)) !== null) {
    const parsed = parseFromHeader(m[1]!);
    if (!parsed) continue;
    const d = domainOf(parsed.email.toLowerCase());
    if (d !== null && d !== tenantDomain) return parsed;
  }
  return null;
}

function parseFromHeader(line: string): ParsedSender | null {
  const angle = line.match(/^(.*?)<\s*([^>\s]+@[^>\s]+)\s*>/);
  if (angle) {
    const rawName = angle[1]!.replace(/["']/g, '').trim();
    const email = angle[2]!.trim();
    if (!email.includes('@')) return null;
    const name = rawName && rawName.toLowerCase() !== email.toLowerCase()
      ? rawName
      : undefined;
    return name ? { email, name } : { email };
  }
  const bare = line.match(/([^\s<>;,]+@[^\s<>;,]+)/);
  if (bare) return { email: bare[1]!.trim() };
  return null;
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

// ── Auth ──────────────────────────────────────────────────────────────

/**
 * Returns a usable JWT, prompting the user to sign in via an Office
 * dialog if we don't have one cached.
 *
 * Why Office.context.ui.displayDialogAsync (not a regular popup):
 *   - Works on Outlook for Mac + mobile (where window.open is blocked).
 *   - Gives us a postMessage channel back to the parent pane that
 *     survives cross-origin (the dialog loads rhud.net, the parent is
 *     addin.rhud.net — vanilla window.open + postMessage would need
 *     window.opener which dialogs don't have).
 */
async function getOrAuthRhudJwt(): Promise<CachedAuth> {
  const cached = readCachedAuth();
  if (cached) return cached;

  return new Promise<CachedAuth>((resolve, reject) => {
    Office.context.ui.displayDialogAsync(
      // Must be same-origin as the add-in (Office enforces strict
      // protocol+host+port match). The outer Caddy at addin.rhud.net
      // proxies /login to the web container so we get the real Rhud
      // login page rendered under this origin.
      `${ADDIN_ORIGIN}/login?return=addin`,
      { height: 60, width: 30, promptBeforeOpen: false },
      (open) => {
        if (open.status !== Office.AsyncResultStatus.Succeeded) {
          reject(new Error(open.error.message));
          return;
        }
        const dialog = open.value;
        dialog.addEventHandler(Office.EventType.DialogMessageReceived, (arg) => {
          // arg.message is whatever the auth-callback page passed to
          // messageParent(). We pass JSON.stringify({token, user}).
          try {
            const payload = JSON.parse((arg as { message: string }).message) as CachedAuth;
            if (!payload.token || !payload.user) throw new Error('Malformed auth payload');
            localStorage.setItem(TOKEN_KEY, payload.token);
            localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
            dialog.close();
            resolve(payload);
          } catch (e) {
            dialog.close();
            reject(e as Error);
          }
        });
        dialog.addEventHandler(Office.EventType.DialogEventReceived, (arg) => {
          // User closed the dialog manually (event code 12006).
          const code = (arg as { error: number }).error;
          if (code === 12006) reject(new Error('Sign-in cancelled'));
        });
      },
    );
  });
}

function readCachedAuth(): CachedAuth | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const userRaw = localStorage.getItem(USER_KEY);
  if (!token || !userRaw) return null;
  // We don't verify expiry locally — the API will return 401 if it's
  // expired, and the submit path handles that by clearing the cache.
  try {
    return { token, user: JSON.parse(userRaw) };
  } catch {
    return null;
  }
}

// ── DOM helpers ───────────────────────────────────────────────────────

function val(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value.trim();
}

function setInput(id: string, value: string): void {
  (document.getElementById(id) as HTMLInputElement).value = value;
}

function setStatus(html: string, kind: 'error' | 'success' | '' = '', allowHtml = false): void {
  const el = document.getElementById('status')!;
  el.className = 'status' + (kind ? ` ${kind}` : '');
  if (allowHtml) el.innerHTML = html;
  else el.textContent = html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}
