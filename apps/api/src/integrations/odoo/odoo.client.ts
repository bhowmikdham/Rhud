/**
 * Odoo XML-RPC client over native fetch — no third-party SDK.
 *
 * Why hand-rolled: the available Node packages either lack TS types,
 * are unmaintained, or pull in noisy XML libs we don't otherwise
 * need. The XML-RPC subset Odoo speaks is small (method calls with
 * primitive params, optional kwargs as a struct) and fits in ~200
 * lines.
 *
 * Endpoints used:
 *   POST {url}/xmlrpc/2/common  — version, authenticate
 *   POST {url}/xmlrpc/2/object  — execute_kw (the workhorse)
 *
 * Per the Odoo Cloud Acceptable Use Policy, throttle to ~1 call/sec
 * and back off on 429. We don't enforce a hard delay here (callers
 * can batch and the Odoo Online server itself rate-limits) but we do
 * a single retry on 429/503.
 */

/* global Response */
import { Logger } from '@nestjs/common';

export class OdooApiError extends Error {
  constructor(
    /** Stable code: 'auth_failed' | 'http_<status>' | 'xmlrpc_fault' | 'access_error' | etc. */
    public readonly code: string,
    /** Optional fault code from Odoo's XML-RPC response. */
    public readonly faultCode: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'OdooApiError';
  }
}

/** A single record returned from a read/search_read. */
export type OdooRecord = Record<string, unknown> & { id?: number };

export interface OdooClientConfig {
  url: string;
  database: string;
  login: string;
  apiKey: string;
  /** Seed uid from a previous authenticate() so we can skip the round-trip. */
  cachedUid?: number | null;
}

/**
 * What Odoo's `search_read` accepts as a domain.
 *
 *   - Tuples:    ['name', '=', 'Acme']
 *   - Operators: '&', '|', '!' as standalone strings (prefix notation).
 *
 * We type loosely as `unknown[]` because Odoo's domain DSL is heterogeneous;
 * callers compose these with the helper below.
 */
export type OdooDomain = ReadonlyArray<unknown>;

export class OdooClient {
  private readonly logger = new Logger(OdooClient.name);
  private uid: number | null;

  constructor(private readonly cfg: OdooClientConfig) {
    this.uid = cfg.cachedUid ?? null;
  }

  /** Returns the Odoo server version string (e.g. "17.0+e"). Cheap; no auth. */
  async version(): Promise<{ serverVersion: string; rawVersionInfo: unknown }> {
    const body = buildXmlRpcCall('version', []);
    const out = await this.xmlrpcCall('/xmlrpc/2/common', body);
    const v = out as { server_version?: string; server_version_info?: unknown };
    return {
      serverVersion: typeof v.server_version === 'string' ? v.server_version : 'unknown',
      rawVersionInfo: v.server_version_info ?? null,
    };
  }

  /**
   * Authenticate with the configured (login, api_key) and cache the uid.
   * Throws OdooApiError('auth_failed') on bad creds.
   */
  async authenticate(): Promise<number> {
    const body = buildXmlRpcCall('authenticate', [
      this.cfg.database,
      this.cfg.login,
      this.cfg.apiKey,
      {},
    ]);
    const out = await this.xmlrpcCall('/xmlrpc/2/common', body);
    if (typeof out !== 'number' || out <= 0) {
      throw new OdooApiError('auth_failed', null, 'Odoo authenticate returned no uid (check db/login/api key)');
    }
    this.uid = out;
    return out;
  }

  /** Returns the cached uid, authenticating first if needed. */
  private async ensureUid(): Promise<number> {
    if (this.uid != null && this.uid > 0) return this.uid;
    return this.authenticate();
  }

  /**
   * The workhorse. Calls `execute_kw` on `/xmlrpc/2/object`.
   *
   *   client.executeKw('crm.lead', 'search_read', [[]], { fields: ['id','name'], limit: 10 })
   *
   * On a 401/access-error we re-authenticate ONCE and retry; in
   * practice that handles the case where Odoo restarted and our
   * cached uid is no longer valid.
   */
  async executeKw<T = unknown>(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
  ): Promise<T> {
    const uid = await this.ensureUid();
    const params = [
      this.cfg.database,
      uid,
      this.cfg.apiKey,
      model,
      method,
      args,
      kwargs,
    ];
    const body = buildXmlRpcCall('execute_kw', params);

    try {
      return (await this.xmlrpcCall('/xmlrpc/2/object', body)) as T;
    } catch (e) {
      if (
        e instanceof OdooApiError &&
        (e.code === 'auth_failed' || e.code === 'access_error') &&
        this.uid != null
      ) {
        // Reauth once and retry — handles restarted Odoo / rotated session.
        this.uid = null;
        const newUid = await this.authenticate();
        params[1] = newUid;
        const retryBody = buildXmlRpcCall('execute_kw', params);
        return (await this.xmlrpcCall('/xmlrpc/2/object', retryBody)) as T;
      }
      throw e;
    }
  }

  // ── Convenience helpers — the methods callers actually want ─────────

  /** search_read: query → array of records. */
  searchRead<T extends OdooRecord = OdooRecord>(
    model: string,
    domain: OdooDomain = [],
    opts: { fields?: string[]; limit?: number; offset?: number; order?: string } = {},
  ): Promise<T[]> {
    return this.executeKw<T[]>(model, 'search_read', [domain], {
      ...(opts.fields && opts.fields.length > 0 ? { fields: opts.fields } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.offset ? { offset: opts.offset } : {}),
      ...(opts.order ? { order: opts.order } : {}),
    });
  }

  /** read by id list. */
  read<T extends OdooRecord = OdooRecord>(
    model: string,
    ids: number[],
    fields: string[] = [],
  ): Promise<T[]> {
    return this.executeKw<T[]>(model, 'read', [ids], fields.length ? { fields } : {});
  }

  /** count records matching a domain. */
  searchCount(model: string, domain: OdooDomain = []): Promise<number> {
    return this.executeKw<number>(model, 'search_count', [domain], {});
  }

  /** create one or many — returns the new id (Odoo returns array on batch). */
  async create(model: string, values: Record<string, unknown> | Record<string, unknown>[]): Promise<number | number[]> {
    return this.executeKw<number | number[]>(model, 'create', [values], {});
  }

  /** write — true on success. */
  async write(
    model: string,
    ids: number | number[],
    values: Record<string, unknown>,
  ): Promise<boolean> {
    const idArr = Array.isArray(ids) ? ids : [ids];
    return this.executeKw<boolean>(model, 'write', [idArr, values], {});
  }

  /** unlink — true on success. Hard delete; use with care. */
  async unlink(model: string, ids: number | number[]): Promise<boolean> {
    const idArr = Array.isArray(ids) ? ids : [ids];
    return this.executeKw<boolean>(model, 'unlink', [idArr], {});
  }

  /** fields_get — schema introspection for a model. */
  fieldsGet(model: string, attributes: string[] = ['string', 'type', 'help', 'required', 'readonly']): Promise<Record<string, unknown>> {
    return this.executeKw<Record<string, unknown>>(model, 'fields_get', [], {
      attributes,
    });
  }

  /** Generic action call — for routes like `action_set_won`, `message_post`. */
  callAction<T = unknown>(model: string, method: string, ids: number | number[], extraArgs: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<T> {
    const idArr = Array.isArray(ids) ? ids : [ids];
    return this.executeKw<T>(model, method, [idArr, ...extraArgs], kwargs);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async xmlrpcCall(path: string, body: string): Promise<unknown> {
    const baseUrl = this.cfg.url.replace(/\/$/, '');
    const url = `${baseUrl}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/xml' },
        body,
      });
    } catch (e) {
      throw new OdooApiError(
        'network_error',
        null,
        `odoo network error calling ${path}: ${(e as Error).message}`,
      );
    }

    if (res.status === 429 || res.status === 503) {
      // Single retry after a polite delay.
      await new Promise((r) => setTimeout(r, 1500));
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'text/xml' },
          body,
        });
      } catch (e) {
        throw new OdooApiError(
          'network_error',
          null,
          `odoo retry failed: ${(e as Error).message}`,
        );
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OdooApiError(
        `http_${res.status}`,
        null,
        `odoo HTTP ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    const text = await res.text();
    return parseXmlRpcResponse(text);
  }
}

// ── Domain composition helpers (exported for callers) ─────────────────

/** Build an Odoo domain triple. */
export function leaf(field: string, op: string, value: unknown): readonly unknown[] {
  return [field, op, value];
}

/** Convenience — joins multiple domain leaves with explicit AND. Odoo
 *  defaults to AND when leaves are listed without a connector, so this
 *  is mostly for readability. */
export function andDomain(...leaves: ReadonlyArray<ReadonlyArray<unknown>>): unknown[] {
  return leaves.flat() as unknown[];
}

// ── XML-RPC encode / decode ───────────────────────────────────────────
//
// Just enough to talk to Odoo. We support: int, double, string, bool,
// dateTime, base64 (rare here), array, struct. Faults come back as
// `<methodResponse><fault>` and we surface them as OdooApiError.

function buildXmlRpcCall(method: string, params: unknown[]): string {
  const paramsXml = params.map((p) => `<param>${encodeValue(p)}</param>`).join('');
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${paramsXml}</params></methodCall>`;
}

function encodeValue(v: unknown): string {
  if (v === null || v === undefined) return '<value><nil/></value>';
  if (typeof v === 'string') return `<value><string>${escapeXml(v)}</string></value>`;
  if (typeof v === 'boolean') return `<value><boolean>${v ? '1' : '0'}</boolean></value>`;
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
      return `<value><int>${v}</int></value>`;
    }
    return `<value><double>${v}</double></value>`;
  }
  if (v instanceof Date) {
    return `<value><dateTime.iso8601>${formatDate(v)}</dateTime.iso8601></value>`;
  }
  if (Buffer.isBuffer(v)) {
    return `<value><base64>${v.toString('base64')}</base64></value>`;
  }
  if (Array.isArray(v)) {
    const items = v.map((x) => encodeValue(x)).join('');
    return `<value><array><data>${items}</data></array></value>`;
  }
  if (typeof v === 'object') {
    const members = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `<member><name>${escapeXml(k)}</name>${encodeValue(val)}</member>`)
      .join('');
    return `<value><struct>${members}</struct></value>`;
  }
  // Fallback — stringify.
  return `<value><string>${escapeXml(String(v))}</string></value>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Minimal XML-RPC response parser. Hand-rolled because pulling in a
 * full XML parser for this single use case isn't worth it. Handles
 * faults, arrays, structs, primitives.
 */
function parseXmlRpcResponse(xml: string): unknown {
  const trimmed = xml.trim();

  // Fault path — Odoo returns these for access errors / business
  // validation / model not found. The body shape is documented at
  // http://xmlrpc.com/spec — faultCode is int, faultString is text.
  const faultMatch = /<fault>([\s\S]*?)<\/fault>/.exec(trimmed);
  if (faultMatch) {
    const inner = faultMatch[1] ?? '';
    const parsed = parseValue(extractValue(inner));
    if (parsed && typeof parsed === 'object') {
      const r = parsed as { faultCode?: unknown; faultString?: unknown };
      const code = typeof r.faultCode === 'number' ? r.faultCode : null;
      const msg = typeof r.faultString === 'string' ? r.faultString : 'odoo fault';
      // Odoo encodes access errors with specific server-side classes.
      const stable = msg.toLowerCase().includes('access denied')
        ? 'access_error'
        : msg.toLowerCase().includes('access error')
        ? 'access_error'
        : 'xmlrpc_fault';
      throw new OdooApiError(stable, code, msg);
    }
    throw new OdooApiError('xmlrpc_fault', null, 'Unparseable XML-RPC fault');
  }

  // Standard methodResponse → params → param → value
  const valueMatch = extractFirstParamValue(trimmed);
  if (!valueMatch) {
    throw new OdooApiError('xmlrpc_parse_error', null, 'No <value> in response');
  }
  return parseValue(valueMatch);
}

function extractFirstParamValue(xml: string): string | null {
  const m = /<methodResponse>[\s\S]*?<params>[\s\S]*?<param>([\s\S]*?)<\/param>[\s\S]*?<\/params>[\s\S]*?<\/methodResponse>/.exec(xml);
  if (!m) return null;
  return extractValue(m[1] ?? '');
}

function extractValue(xml: string): string {
  // Returns the substring between the first <value>...</value> at the
  // outermost level. We handle nesting by tracking depth.
  const open = xml.indexOf('<value>');
  if (open === -1) return '';
  let depth = 0;
  let i = open;
  while (i < xml.length) {
    if (xml.startsWith('<value>', i)) {
      depth++;
      i += '<value>'.length;
    } else if (xml.startsWith('</value>', i)) {
      depth--;
      if (depth === 0) {
        return xml.slice(open + '<value>'.length, i);
      }
      i += '</value>'.length;
    } else {
      i++;
    }
  }
  return '';
}

function parseValue(inner: string): unknown {
  const t = inner.trim();
  if (t.length === 0) return '';

  // Tag-typed values.
  const tagMatch = /^<(\w+(?:\.\w+)?)>([\s\S]*?)<\/\1>$/.exec(t);
  if (tagMatch) {
    const tag = tagMatch[1] ?? '';
    const body = tagMatch[2] ?? '';
    switch (tag) {
      case 'string':
        return decodeXml(body);
      case 'int':
      case 'i4':
      case 'i8':
        return parseInt(body, 10);
      case 'double':
        return parseFloat(body);
      case 'boolean':
        return body.trim() === '1';
      case 'nil':
        return null;
      case 'dateTime.iso8601':
        return parseOdooDate(body.trim());
      case 'base64':
        return Buffer.from(body, 'base64');
      case 'array':
        return parseArray(body);
      case 'struct':
        return parseStruct(body);
    }
  }

  // Untagged → bare string per spec.
  return decodeXml(t);
}

function parseArray(body: string): unknown[] {
  const dataMatch = /<data>([\s\S]*?)<\/data>/.exec(body);
  if (!dataMatch) return [];
  const out: unknown[] = [];
  const data = dataMatch[1] ?? '';
  let i = 0;
  while (i < data.length) {
    const open = data.indexOf('<value>', i);
    if (open === -1) break;
    let depth = 0;
    let j = open;
    while (j < data.length) {
      if (data.startsWith('<value>', j)) {
        depth++;
        j += '<value>'.length;
      } else if (data.startsWith('</value>', j)) {
        depth--;
        if (depth === 0) {
          out.push(parseValue(data.slice(open + '<value>'.length, j)));
          j += '</value>'.length;
          i = j;
          break;
        }
        j += '</value>'.length;
      } else {
        j++;
      }
    }
    if (j >= data.length) break;
  }
  return out;
}

function parseStruct(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Each member is <member><name>...</name><value>...</value></member>
  const re = /<member>\s*<name>([\s\S]*?)<\/name>\s*([\s\S]*?)<\/member>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const name = decodeXml((m[1] ?? '').trim());
    const valueRaw = m[2] ?? '';
    const open = valueRaw.indexOf('<value>');
    if (open === -1) continue;
    let depth = 0;
    let j = open;
    while (j < valueRaw.length) {
      if (valueRaw.startsWith('<value>', j)) {
        depth++;
        j += '<value>'.length;
      } else if (valueRaw.startsWith('</value>', j)) {
        depth--;
        if (depth === 0) {
          out[name] = parseValue(valueRaw.slice(open + '<value>'.length, j));
          break;
        }
        j += '</value>'.length;
      } else {
        j++;
      }
    }
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function parseOdooDate(s: string): Date {
  // Odoo emits "YYYYMMDDTHH:MM:SS" without timezone — treat as UTC.
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? new Date(0) : d;
  }
  return new Date(Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  ));
}
