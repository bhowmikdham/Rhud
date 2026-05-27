/**
 * Task pane entry. Runs inside the Outlook host (web, desktop, mobile).
 *
 * Lifecycle:
 *   1. Office.onReady fires once the host has injected the mailbox context.
 *   2. Pre-fill the form from the currently-open message
 *      (subject, from-address, from-name, plain-text body).
 *   3. Fetch the tenant's published templates (requires a Rhud JWT —
 *      if we don't have one, open the sign-in dialog first).
 *   4. On submit, POST to /api/v1/opportunities/from-email. The endpoint
 *      is idempotent on the email's Message-Id, so accidental double-clicks
 *      don't create duplicates.
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

interface CreateOpportunityResponse {
  engagementId: string;
  token: string;
  url: string;
  expiresAt: string;
}

interface CachedAuth {
  token: string;
  user: { sub: string; tid: string; role: string; email: string };
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

  prefillFromMessage(item);

  // Wire up the form's submit + sign-out handlers regardless of auth
  // state — they're idempotent and need to be ready by the time the
  // user clicks them after sign-in.
  document.getElementById('opportunity-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitForm(item);
  });
  document.getElementById('signout')!.addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    showSignInPrompt();
    setStatus('Signed out.', 'success');
  });

  // Auth gate. If we already have a token, load templates and show the
  // form. If not, show a "Sign in" button — clicking it (a real user
  // gesture) is what's allowed to open the Office dialog. Auto-opening
  // the dialog from onReady would be treated as an unsolicited popup
  // and blocked by the browser.
  const cached = readCachedAuth();
  if (cached) {
    showForm();
    await loadTemplates(cached.token);
  } else {
    showSignInPrompt();
  }

  document.getElementById('signin')!.addEventListener('click', async () => {
    try {
      const auth = await getOrAuthRhudJwt();
      showForm();
      await loadTemplates(auth.token);
    } catch (err) {
      setStatus(`Sign-in failed: ${(err as Error).message}`, 'error');
    }
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

function prefillFromMessage(item: Office.MessageRead): void {
  setInput('subject', item.subject ?? '');
  setInput('fromEmail', item.from?.emailAddress ?? '');
  setInput('fromName', item.from?.displayName ?? '');

  // Body comes back async (the host fetches it on demand). Truncate
  // display because the textarea is small; the full body still gets
  // sent to the API on submit.
  item.body.getAsync(Office.CoercionType.Text, (r) => {
    if (r.status === Office.AsyncResultStatus.Succeeded) {
      const ta = document.getElementById('body') as HTMLTextAreaElement;
      ta.value = r.value.slice(0, 2000);
      ta.dataset.full = r.value;
    } else {
      setStatus(`Couldn't read message body: ${r.error.message}`, 'error');
    }
  });
}

async function loadTemplates(jwt: string): Promise<void> {
  const select = document.getElementById('templateId') as HTMLSelectElement;
  const res = await fetch(`${RHUD_API}/api/v1/templates`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    select.innerHTML = '<option value="">Failed to load templates</option>';
    setStatus(`Templates: ${res.status}`, 'error');
    return;
  }
  const all = (await res.json()) as TemplateListItem[];
  // Filter client-side because the API doesn't currently support
  // ?status=published. Cheap — tenants rarely have more than a few dozen.
  const published = all.filter((t) => t.status === 'published');
  if (published.length === 0) {
    select.innerHTML = '<option value="">No published templates</option>';
    setStatus('Publish a template in Rhud before creating opportunities.', 'error');
    return;
  }
  select.innerHTML = published
    .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
    .join('');
}

async function submitForm(item: Office.MessageRead): Promise<void> {
  const submitBtn = document.getElementById('create') as HTMLButtonElement;
  submitBtn.disabled = true;
  setStatus('Creating opportunity…');

  try {
    const auth = await getOrAuthRhudJwt();
    const bodyTextarea = document.getElementById('body') as HTMLTextAreaElement;
    const fullBody = bodyTextarea.dataset.full ?? bodyTextarea.value;

    // internetMessageId is the RFC822 Message-Id (e.g. "<abc@host>"). Used
    // server-side for idempotency. If Outlook can't give us one (rare —
    // drafts before send), fall back to a synthetic id based on subject +
    // from + a timestamp so retries within the same session still dedup.
    const messageId = item.internetMessageId
      ?? `synthetic-${val('fromEmail')}-${val('subject')}-${Date.now()}`;

    const body = {
      templateId: val('templateId'),
      fromEmail: val('fromEmail'),
      fromName: val('fromName') || undefined,
      clientNameOverride: val('clientNameOverride') || undefined,
      subject: val('subject'),
      bodyText: fullBody,
      messageId,
      source: 'outlook' as const,
    };

    const res = await fetch(`${RHUD_API}/api/v1/opportunities/from-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      // Token expired. Clear cache and prompt re-auth.
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      setStatus('Session expired. Click Create again to sign back in.', 'error');
      return;
    }
    if (!res.ok) {
      const err = await res.text();
      setStatus(`Create failed (${res.status}): ${err.slice(0, 200)}`, 'error');
      return;
    }

    const data = (await res.json()) as CreateOpportunityResponse;
    const oppUrl = `${RHUD_WEB}/opportunities/${data.engagementId}`;
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

