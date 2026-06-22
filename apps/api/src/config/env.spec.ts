import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.js';

const validProd = (): Record<string, string> => ({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://owner:pw@db:5432/rhud',
  APP_DATABASE_URL: 'postgres://rhud_app:pw@db:5432/rhud',
  JWT_SECRET: 'x'.repeat(32),
  LLM_KEY_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), // 44-char b64 = 32 bytes
});

describe('loadEnv — LLM_KEY_ENCRYPTION_KEY production enforcement', () => {
  it('passes with a valid 32-byte key in production', () => {
    expect(() => loadEnv(validProd())).not.toThrow();
  });

  it('THROWS in production when the key is missing (would silently break decryption after restart)', () => {
    const { LLM_KEY_ENCRYPTION_KEY: _omit, ...env } = validProd();
    void _omit;
    expect(() => loadEnv(env)).toThrow(/LLM_KEY_ENCRYPTION_KEY/);
  });

  it('THROWS in production when the key is not 32 bytes', () => {
    expect(() => loadEnv({ ...validProd(), LLM_KEY_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(
      /32 bytes/,
    );
  });

  it('does NOT enforce the key outside production (dev convenience)', () => {
    expect(() =>
      loadEnv({ NODE_ENV: 'development', DATABASE_URL: 'postgres://u:p@db:5432/rhud', JWT_SECRET: 'x'.repeat(32) }),
    ).not.toThrow();
  });
});
