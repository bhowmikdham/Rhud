/**
 * Envelope encryption for tenant LLM API keys.
 *
 *   plaintext key
 *     │
 *     ▼  AES-256-GCM with random per-config DEK (32B)
 *   ┌───────────────────────┐
 *   │ api_key_ciphertext + IV│
 *   └───────────────────────┘
 *
 *   DEK
 *     │
 *     ▼  AES-256-GCM with master key (LLM_KEY_ENCRYPTION_KEY, 32B base64)
 *   ┌───────────────────────────┐
 *   │ api_key_dek_ciphertext + IV│
 *   └───────────────────────────┘
 *
 * Why envelope vs. encrypting directly with the master:
 *   - Master key rotation only requires rewrapping each DEK, not
 *     re-encrypting every plaintext.
 *   - Different tenants' keys can't be cross-decrypted with the same IV
 *     even on key reuse bugs — each row has its own DEK.
 *
 * The master key in dev is randomly generated on first import (see
 * resolveMasterKey). Production MUST set LLM_KEY_ENCRYPTION_KEY explicitly
 * — a missing prod env throws on first encryption attempt rather than
 * silently using a fresh key (which would break decryption on restart).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

export interface EncryptedKey {
  apiKeyCiphertext: Buffer;
  apiKeyIv: Buffer;
  apiKeyDekCiphertext: Buffer;
  apiKeyDekIv: Buffer;
}

let cachedMaster: Buffer | null = null;

function resolveMasterKey(): Buffer {
  if (cachedMaster) return cachedMaster;

  const fromEnv = process.env.LLM_KEY_ENCRYPTION_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length !== KEY_LEN) {
      throw new Error(
        `LLM_KEY_ENCRYPTION_KEY must decode to ${KEY_LEN} bytes (got ${buf.length}). ` +
          `Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    cachedMaster = buf;
    return buf;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'LLM_KEY_ENCRYPTION_KEY is required in production. ' +
        'Tenant API keys cannot be persisted without it.',
    );
  }

  // Dev fallback — pin a random key per process. Acceptable because the
  // dev DB is throwaway; if you encrypt a key and then restart, you lose
  // it (and the validation in writeConfig surfaces this clearly).
  cachedMaster = randomBytes(KEY_LEN);
  return cachedMaster;
}

function encryptWith(key: Buffer, plaintext: Buffer): { ciphertext: Buffer; iv: Buffer } {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Append the GCM auth tag to the ciphertext — gives us authenticated
  // decryption from a single buffer per field.
  return { ciphertext: Buffer.concat([enc, tag]), iv };
}

function decryptWith(key: Buffer, ciphertext: Buffer, iv: Buffer): Buffer {
  if (ciphertext.length < TAG_LEN) throw new Error('ciphertext too short');
  const enc = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
  const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

export function encryptApiKey(plaintext: string): EncryptedKey {
  const master = resolveMasterKey();
  const dek = randomBytes(KEY_LEN);

  const inner = encryptWith(dek, Buffer.from(plaintext, 'utf8'));
  const wrapped = encryptWith(master, dek);

  return {
    apiKeyCiphertext: inner.ciphertext,
    apiKeyIv: inner.iv,
    apiKeyDekCiphertext: wrapped.ciphertext,
    apiKeyDekIv: wrapped.iv,
  };
}

export function decryptApiKey(parts: EncryptedKey): string {
  const master = resolveMasterKey();
  const dek = decryptWith(master, parts.apiKeyDekCiphertext, parts.apiKeyDekIv);
  const pt = decryptWith(dek, parts.apiKeyCiphertext, parts.apiKeyIv);
  return pt.toString('utf8');
}
