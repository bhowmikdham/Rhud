/**
 * Tokenised gathering link primitives.
 *
 * Design contract (§3.1, §4.6):
 *   - Plaintext token: 256-bit random, base64url-encoded.
 *   - Stored: argon2id hash. Plaintext is shown to the issuer exactly once.
 *   - Verify: linear scan over candidate hashes, argon2.verify each. The
 *     hash makes a brute-force from the DB infeasible.
 *   - Device fingerprint: SHA-256 of (user-agent + ip-prefix + accept-lang).
 *     Loose enough to survive normal browsing (port changes, IPv6 dyn),
 *     tight enough to flag a different device.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';

/** 256-bit base64url plaintext token. ~43 chars, URL-safe. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/** argon2id with cost params suited for short-lived tokens (15-day expiry). */
export async function hashToken(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

export async function verifyToken(hash: string, plaintext: string): Promise<boolean> {
  // argon2.verify already does timing-constant comparison internally.
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    // Malformed hash or unknown variant — treat as a non-match, never throw
    // out to the request handler (would leak info about token store state).
    return false;
  }
}

/**
 * Deterministic fingerprint of a request — used to detect device changes on
 * subsequent token uses. Intentionally lossy:
 *   - takes IPv4 /24 or IPv6 /48 prefix (so IP shuffles within a network are OK)
 *   - takes user-agent verbatim (shifts indicate a different browser)
 *   - takes accept-language top entry
 *
 * If the new fingerprint differs from the bound one, the gathering layer
 * forces a re-verify (sprint 3 stub: return 401 + tell the client to request
 * a new link; OTP email flow lands in a later sprint).
 */
export function deviceFingerprint(parts: {
  ip: string;
  userAgent: string;
  acceptLanguage?: string;
}): string {
  const ipPrefix = ipNetworkPrefix(parts.ip);
  const lang = (parts.acceptLanguage ?? '').split(',')[0]?.trim() ?? '';
  return createHash('sha256')
    .update(`${ipPrefix}|${parts.userAgent}|${lang}`)
    .digest('hex');
}

/** Reduce a client IP to a /24 (v4) or /48 (v6) prefix for audit
 *  payloads — full IPs are PII in some jurisdictions. Exported for
 *  Phase E partner intake which logs the source IP into thread events. */
export function ipNetworkPrefix(ip: string): string {
  // IPv4 → /24
  const v4 = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) return v4[1] + '.0/24';
  // IPv6 → /48 (first three colon-groups)
  if (ip.includes(':')) {
    const groups = ip.split(':');
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return ip;
}

/**
 * Constant-time hex comparison. Used when comparing a freshly-computed
 * fingerprint against the stored bound one (raw SHA-256 hex strings, equal
 * length). For variable-length inputs argon2.verify does the right thing.
 */
export function fingerprintsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
