/**
 * SSRF guard for the site-enumeration crawlers.
 *
 * The crawler fetches rep-supplied URLs server-side, so without a guard a rep
 * (or a stolen rep JWT) can point it at internal infrastructure — most
 * dangerously the cloud instance-metadata endpoint (169.254.169.254) to
 * exfiltrate IAM credentials, or localhost-only admin services. This module
 * resolves the target host and rejects any address in a loopback / private /
 * link-local / unique-local / CGNAT range, and re-checks on every redirect hop.
 *
 * Residual risk: this resolves-then-connects, so a sub-second DNS rebind
 * between the check and the actual connect is not closed here. The practical
 * holes the audit flagged (no validation at all; redirect-to-internal) are.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const MAX_REDIRECTS = 5;

/** Block 0/8, 10/8, 127/8, 169.254/16 (incl. cloud metadata), 172.16/12,
 *  192.168/16, 192.0.0/24, 100.64/10 (CGNAT), and 224/4+ (multicast/reserved). */
function isBlockedV4(ip: string): boolean {
  const parts = ip.split('.').map((o) => Number(o));
  if (parts.length !== 4 || parts.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/** Block ::, ::1 (loopback), fe80::/10 (link-local), fc00::/7 (unique-local),
 *  and IPv4-mapped addresses whose embedded v4 is blocked. */
function isBlockedV6(ip: string): boolean {
  const a = ip.toLowerCase().split('%')[0] ?? '';
  if (a === '::' || a === '::1') return true;
  if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // fc00::/7 unique-local
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]!);
  return false;
}

/** True if an IP literal is one we must never crawl. Unparseable → blocked. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true;
}

/** Validate scheme + resolve host and reject any private/loopback target.
 *  Throws {@link SsrfError} on any disallowed URL. */
export async function assertPublicUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError(`invalid_url: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfError(`blocked_scheme: ${u.protocol}`);
  }
  const host = u.hostname;
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError(`blocked_ip: ${host}`);
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new SsrfError(`dns_resolution_failed: ${host}`);
  }
  if (addrs.length === 0) throw new SsrfError(`no_dns_records: ${host}`);
  // Block if ANY resolved address is private (defends against a record that
  // returns both a public and a private A record).
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new SsrfError(`blocked_ip: ${host} -> ${a.address}`);
  }
}

/** `fetch()` that validates the target — and every redirect hop — is a public
 *  host before connecting. Use everywhere the crawler talks to a rep-supplied
 *  origin. Caller-supplied `redirect` is ignored (always handled manually). */
export async function safeFetch(
  url: string,
  init: NonNullable<Parameters<typeof fetch>[1]> = {},
  maxRedirects = MAX_REDIRECTS,
): Promise<Awaited<ReturnType<typeof fetch>>> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res; // 3xx without Location — hand back as-is
      const next = new URL(loc, current).toString();
      await res.body?.cancel().catch(() => undefined);
      current = next;
      continue;
    }
    return res;
  }
  throw new SsrfError(`too_many_redirects: ${url}`);
}
