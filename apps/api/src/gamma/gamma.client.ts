/* global AbortController, Response */
/**
 * HTTP client for Gamma's Generate API.
 *
 * The endpoint shape below is calibrated to Gamma's published API
 * surface: POST /v0.2/generations with a markdown/text prompt + a few
 * options, returning a generation id you poll for completion. Confirm
 * the exact path + payload against the customer's Gamma account before
 * shipping to prod — Gamma's API is in active development and field
 * names sometimes shift between versions.
 *
 * Failure posture: every method returns a typed result or throws an
 * Error with a useful message. The caller (GammaDraftService) wraps
 * these into BadGateway responses for the UI.
 */

const DEFAULT_BASE = 'https://public-api.gamma.app';
// Gamma sunset /v0.2 in mid-2026. Using v1.0 going forward — same
// payload shape (`inputText`, `format`, `textMode`, etc.) per their
// developer docs at https://developers.gamma.app.
const API_VERSION = 'v1.0';

export interface GeneratedDeck {
  /** Gamma-side id used for status polling + downstream references. */
  generationId: string;
  /** Public viewer URL when ready. May be null while still processing. */
  url: string | null;
  /**
   * Gamma's status enum. The public docs only document three terminal-ish
   * values — `pending`, `completed`, `failed` — but earlier API revisions
   * shipped `queued` / `processing`, so we accept anything here and the
   * caller treats !completed && !failed as still-in-progress.
   */
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | string;
  /** Human-readable error message when status === 'failed'. */
  error?: string;
  /** Workspace credits remaining after this generation, when surfaced. */
  creditsRemaining?: number;
  /** Credits this specific generation consumed, when surfaced. */
  creditsDeducted?: number;
  /**
   * `x-ratelimit-remaining-burst`. When low (< ~100 per the docs) callers
   * should slow their poll cadence to ~15s to avoid 429s.
   */
  burstRemaining?: number;
  /**
   * Pre-signed URL for the exported file when the create call set
   * `exportAs`. Per Gamma's docs the URL is valid for ~7 days; persist
   * an expiry alongside it if you cache. Only one format per
   * generation — request what you actually need at create time.
   */
  exportUrl?: string;
}

/**
 * Thrown when Gamma returns 429. Carries the suggested wait so the
 * caller can honour `Retry-After` instead of guessing.
 */
export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs: number, message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/** Subset of Gamma's `sharingOptions` we actually set. Full schema in
 *  https://developers.gamma.app/guides/generate-api-parameters-explained.
 *  Importantly, `externalAccess` controls whether the deck URL renders
 *  for anyone outside the Gamma workspace — including iframes embedded
 *  on third-party sites (e.g. Rhud's proposal preview). */
export interface GammaSharingOptions {
  workspaceAccess?: 'noAccess' | 'view' | 'comment' | 'edit' | 'fullAccess';
  externalAccess?: 'noAccess' | 'view' | 'comment' | 'edit';
}

export interface GammaCreateInput {
  /** Markdown / freeform prompt that will become the deck contents. */
  inputText: string;
  /** Optional Gamma workspace id when the API account spans many. */
  workspaceId?: string;
  /** "presentation" | "document" | "social" — defaults to presentation. */
  format?: 'presentation' | 'document' | 'social';
  /** Theme id from the Gamma library (defaults to Gamma's pick). */
  themeName?: string;
  /** "generate" creates a new deck; "rewrite" updates an existing. */
  textMode?: 'generate' | 'condense' | 'preserve';
  /** Number of cards/slides; null = let Gamma choose. */
  numCards?: number;
  /** Workspace + external access. Set externalAccess=view to let clients
   *  open the deck and to allow iframe embedding. */
  sharingOptions?: GammaSharingOptions;
  /** When set, Gamma generates the deck AND a downloadable export in
   *  the requested format. The `exportUrl` lands on the polled GET
   *  response when the generation completes. Only one format per
   *  request; the URL expires ~7 days later. */
  exportAs?: 'pdf' | 'pptx' | 'png';
}

/** Input for the separate /generations/from-template endpoint. Field
 *  shape differs from GammaCreateInput per Gamma's docs:
 *    - `prompt` (not `inputText`)
 *    - `gammaId` is the source template's File ID
 *    - no `format` / `textMode` — both come from the template */
export interface GammaCreateFromTemplateInput {
  prompt: string;
  /** File ID of the Gamma deck/template to clone from. The source must
   *  contain exactly one Page per Gamma's docs. */
  gammaId: string;
  /** Theme to apply on top of the template (rare). */
  themeId?: string;
  /** Same rationale as on GammaCreateInput — needed for iframe preview. */
  sharingOptions?: GammaSharingOptions;
  /** Same as GammaCreateInput.exportAs. Persist the resulting URL on
   *  the engagement so the Send-to-client modal can attach the PDF. */
  exportAs?: 'pdf' | 'pptx' | 'png';
}

export class GammaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: { apiKey: string; baseUrl?: string | undefined }) {
    if (!opts.apiKey) throw new Error('gamma api key required');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  }

  /** Kick off a new deck generation. Returns a polling handle. */
  async create(input: GammaCreateInput, opts: { timeoutMs?: number } = {}): Promise<GeneratedDeck> {
    const body: Record<string, unknown> = {
      inputText: input.inputText,
      format: input.format ?? 'presentation',
      textMode: input.textMode ?? 'generate',
    };
    if (input.workspaceId) body.workspaceId = input.workspaceId;
    if (input.themeName) body.themeName = input.themeName;
    if (input.numCards != null) body.numCards = input.numCards;
    if (input.sharingOptions) body.sharingOptions = input.sharingOptions;
    if (input.exportAs) body.exportAs = input.exportAs;

    const { data: json } = await this.fetchJson<Record<string, unknown>>(
      `/${API_VERSION}/generations`,
      { method: 'POST', body: JSON.stringify(body), timeoutMs: opts.timeoutMs ?? 30_000 },
    );
    const id = typeof json.generationId === 'string' ? json.generationId : null;
    if (!id) throw new Error('gamma create: missing generationId in response');
    return {
      generationId: id,
      url: pickUrl(json),
      status: (typeof json.status === 'string' ? json.status : 'pending') as GeneratedDeck['status'],
      ...(typeof json.error === 'string' && { error: json.error }),
    };
  }

  /**
   * Generate a deck *from an existing Gamma template*. Different
   * endpoint, different field names — see Gamma's docs at
   * https://developers.gamma.app/generations/create-from-template.
   * The template's structure is preserved; the prompt only fills
   * content where the template has placeholders.
   */
  async createFromTemplate(
    input: GammaCreateFromTemplateInput,
    opts: { timeoutMs?: number } = {},
  ): Promise<GeneratedDeck> {
    const body: Record<string, unknown> = {
      prompt: input.prompt,
      gammaId: input.gammaId,
    };
    if (input.themeId) body.themeId = input.themeId;
    if (input.sharingOptions) body.sharingOptions = input.sharingOptions;
    if (input.exportAs) body.exportAs = input.exportAs;

    const { data: json } = await this.fetchJson<Record<string, unknown>>(
      `/${API_VERSION}/generations/from-template`,
      { method: 'POST', body: JSON.stringify(body), timeoutMs: opts.timeoutMs ?? 30_000 },
    );
    const id = typeof json.generationId === 'string' ? json.generationId : null;
    if (!id) throw new Error('gamma create-from-template: missing generationId in response');
    return {
      generationId: id,
      url: pickUrl(json),
      // The template endpoint's response is `{generationId, warnings}` —
      // no status field. Treat as "pending" until polling tells us otherwise.
      status: 'pending',
    };
  }

  /** Poll a single generation. Returns its current state, plus any
   *  credits / rate-limit headers Gamma surfaced so callers can adapt. */
  async get(generationId: string, opts: { timeoutMs?: number } = {}): Promise<GeneratedDeck> {
    const { data: json, headers } = await this.fetchJson<Record<string, unknown>>(
      `/${API_VERSION}/generations/${encodeURIComponent(generationId)}`,
      { method: 'GET', timeoutMs: opts.timeoutMs ?? 15_000 },
    );
    const credits = (json.credits ?? null) as { deducted?: number; remaining?: number } | null;
    const burstStr = headers.get('x-ratelimit-remaining-burst');
    const burstRemaining = burstStr != null && burstStr !== '' ? Number(burstStr) : undefined;
    // Gamma's failed responses ship the human message inside `error.message`
    // (per ErrorResponse schema in the docs); older revisions used a
    // top-level `error: string`. Accept both.
    const errMsg =
      typeof json.error === 'string'
        ? json.error
        : typeof (json.error as { message?: unknown } | null)?.message === 'string'
        ? ((json.error as { message: string }).message)
        : undefined;
    const exportUrl = typeof json.exportUrl === 'string' ? json.exportUrl : undefined;
    return {
      generationId: typeof json.generationId === 'string' ? json.generationId : generationId,
      url: pickUrl(json),
      status: (typeof json.status === 'string' ? json.status : 'pending') as GeneratedDeck['status'],
      ...(errMsg && { error: errMsg }),
      ...(typeof credits?.remaining === 'number' && { creditsRemaining: credits.remaining }),
      ...(typeof credits?.deducted === 'number' && { creditsDeducted: credits.deducted }),
      ...(typeof burstRemaining === 'number' && Number.isFinite(burstRemaining) && { burstRemaining }),
      ...(exportUrl && { exportUrl }),
    };
  }

  /**
   * Convenience: create + poll until terminal. Useful for the synchronous
   * "Generate proposal" UX where the user expects to land on a finished
   * deck. For long generations the caller should use create() + poll
   * separately so the request can return a link mid-process.
   */
  async createAndAwait(
    input: GammaCreateInput,
    opts: { pollIntervalMs?: number; maxWaitMs?: number } = {},
  ): Promise<GeneratedDeck> {
    return this.awaitFor(await this.create(input), opts);
  }

  /** Same as createAndAwait but for the from-template endpoint. */
  async createFromTemplateAndAwait(
    input: GammaCreateFromTemplateInput,
    opts: { pollIntervalMs?: number; maxWaitMs?: number } = {},
  ): Promise<GeneratedDeck> {
    return this.awaitFor(await this.createFromTemplate(input), opts);
  }

  /**
   * Poll until terminal. Honours Gamma's documented cadence:
   *   - 5s base interval (faster doesn't speed generation, just risks 429s)
   *   - bumps to 15s when `x-ratelimit-remaining-burst < 100`
   *   - on 429 (RateLimitError), waits the suggested `Retry-After` (≥30s)
   *     before retrying — does NOT count toward the deadline so a long
   *     rate-limit pause can't strand a real generation.
   * See https://developers.gamma.app/guides/async-patterns-and-polling.
   */
  private async awaitFor(
    initial: GeneratedDeck,
    opts: { pollIntervalMs?: number; maxWaitMs?: number },
  ): Promise<GeneratedDeck> {
    const baseInterval = opts.pollIntervalMs ?? 5_000;
    const slowInterval = Math.max(baseInterval, 15_000);
    const deadline = Date.now() + (opts.maxWaitMs ?? 300_000); // 5min ceiling per docs
    let deck = initial;
    let interval = baseInterval;
    while (deck.status !== 'completed' && deck.status !== 'failed') {
      if (Date.now() >= deadline) {
        throw new Error(`gamma generation ${deck.generationId} not ready after timeout`);
      }
      await new Promise<void>((r) => setTimeout(r, interval));
      try {
        deck = await this.get(deck.generationId);
      } catch (err) {
        if (err instanceof RateLimitError) {
          // Pause for the suggested duration; deadline pause-extends so
          // we don't fail a real generation just because Gamma throttled.
          const wait = Math.max(err.retryAfterMs, 30_000);
          await new Promise<void>((r) => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
      // Adaptive cadence — slow down before we'd actually start hitting 429s.
      interval =
        typeof deck.burstRemaining === 'number' && deck.burstRemaining < 100
          ? slowInterval
          : baseInterval;
    }
    if (deck.status === 'failed') {
      throw new Error(`gamma generation failed: ${deck.error ?? 'unknown error'}`);
    }
    return deck;
  }

  /**
   * Probe for the "Test connection" button. Gamma's public API has no
   * dedicated /health and no list endpoint, so we GET a syntactically-
   * fine but obviously-fake generation id and read the status code:
   *
   *   401 / 403  → auth rejected → bad key
   *   404 / 400  → server saw our key, just couldn't find the resource → ok
   *   2xx        → unexpected but ok
   *   5xx / net  → upstream broken
   *
   * This avoids the false-negative we saw with the listing endpoint
   * (which returns 404 even with a valid key, since the route doesn't
   * exist).
   */
  async ping(opts: { timeoutMs?: number } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
    const probeId = '_rhud_probe_nonexistent';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/${API_VERSION}/generations/${probeId}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-api-key': this.apiKey,
        },
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === 'AbortError') {
        return { ok: false, error: `timeout after ${opts.timeoutMs ?? 10_000}ms` };
      }
      return { ok: false, error: `gamma fetch failed: ${(err as Error).message}` };
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        error: `auth rejected (${res.status}). ${body.slice(0, 200)}`.trim(),
      };
    }
    if (res.status >= 500) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `gamma upstream ${res.status}. ${body.slice(0, 200)}`.trim() };
    }
    // 200/400/404/422 all mean Gamma processed our request — the key was
    // accepted, the path was reachable. Anything else under 500 is also
    // treated as "auth + URL fine" since it isn't an auth-class response.
    return { ok: true };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async fetchJson<T>(
    path: string,
    init: { method: string; body?: string; timeoutMs: number },
  ): Promise<{ data: T; headers: Headers }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs);

    let res: Response;
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
        // Gamma uses an x-api-key style header per their docs.
        'x-api-key': this.apiKey,
      };
      res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        ...(init.body && { body: init.body }),
        signal: ctrl.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`gamma timeout after ${init.timeoutMs}ms`);
      }
      throw new Error(`gamma fetch failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      // Honour the Retry-After header (seconds, per RFC 7231). Fall back
      // to 30s if absent — that's Gamma's recommended floor for a manual
      // backoff. Body shape is unstable on 429; just ferry the message.
      const retryHeader = res.headers.get('retry-after');
      const retryAfterMs =
        retryHeader != null && /^\d+$/.test(retryHeader)
          ? Number(retryHeader) * 1000
          : 30_000;
      const body = await res.text().catch(() => '');
      throw new RateLimitError(retryAfterMs, `gamma rate-limited (429): ${body.slice(0, 200)}`);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`gamma http ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!text) return { data: {} as T, headers: res.headers };
    try {
      return { data: JSON.parse(text) as T, headers: res.headers };
    } catch {
      throw new Error(`gamma invalid json response: ${text.slice(0, 200)}`);
    }
  }
}

/** Gamma has shipped multiple URL field names across API revisions
 *  (`url`, `gammaUrl`, `viewerUrl`, `link`). Try them in order; fall back
 *  to the first http(s)-shaped string we find on the response object. */
function pickUrl(json: Record<string, unknown>): string | null {
  const keys = ['url', 'gammaUrl', 'viewerUrl', 'link', 'shareUrl'];
  for (const k of keys) {
    const v = json[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(json)) {
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  }
  return null;
}
