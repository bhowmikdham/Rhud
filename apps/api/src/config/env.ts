import { z } from 'zod';

// Runtime env schema. Fail fast on boot if something is missing or malformed.
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(8000),
  API_CORS_ORIGIN: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().url(),
  // Runtime DB URL — connects as rhud_app (NOBYPASSRLS). Optional in dev/test
  // (falls back to DATABASE_URL for local first-runs); REQUIRED in production
  // (enforced by the superRefine below). Falling back to the BYPASSRLS owner in
  // prod would silently disable every tenant RLS policy. CI sets both.
  APP_DATABASE_URL: z.string().url().optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(15),

  // 32-byte master key (base64) used to wrap per-tenant DEKs that encrypt
  // LLM API keys at rest. In dev a default is generated so envelope crypto
  // works out of the box; in prod this MUST be set explicitly. Rotate by
  // re-encrypting tenant_llm_config rows with the new master.
  LLM_KEY_ENCRYPTION_KEY: z.string().optional(),

  // Public URL the web app runs at — used to build the OAuth callback
  // redirects so the user lands back on the right host. Defaults to
  // localhost for dev convenience; set explicitly in prod.
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  // Public URL the API runs at. Used to build the Outlook OAuth
  // redirect URI shown in the admin setup modal (the value the admin
  // must paste into Microsoft Entra). Defaults to localhost; set
  // explicitly in prod so the displayed URI matches what's reachable.
  API_PUBLIC_URL: z.string().url().default('http://localhost:8000'),

  // ── Email (SES) ─────────────────────────────────────────────────
  // Optional. When unset the EmailService is a no-op (dev fallback —
  // the auth controller still returns the magic-link token in the
  // response when NODE_ENV !== 'production', so devs aren't blocked).
  // In prod, set to a verified address on a verified SES domain.
  EMAIL_FROM_ADDRESS: z.string().email().optional(),
  // Region for SES API calls. Defaults to ap-south-1 (where the demo
  // stack lives). The SDK also picks up AWS_REGION if this is unset.
  SES_REGION: z.string().default('ap-south-1'),

  // ── Scheduler ───────────────────────────────────────────────────
  // Master switch for the nightly audit-chain seal cron (AuditSealService).
  // Default on; set to 'false' to disable (e.g. when a dedicated worker owns
  // the sweep, or to silence it on a staging box). The cron also never fires
  // under NODE_ENV=test. Declared here for discoverability + validation; the
  // service reads process.env directly (house pattern), treating anything but
  // the literal 'false' as enabled.
  AUDIT_SEAL_ENABLED: z.enum(['true', 'false']).default('true'),
}).superRefine((env, ctx) => {
  // In production the API must connect as the dedicated rhud_app (NOBYPASSRLS)
  // role. Without APP_DATABASE_URL the Prisma client falls back to DATABASE_URL
  // (the BYPASSRLS table owner), which silently voids every tenant RLS policy —
  // a single missing env var becomes full cross-tenant data exposure.
  if (env.NODE_ENV === 'production' && !env.APP_DATABASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['APP_DATABASE_URL'],
      message:
        'APP_DATABASE_URL is required in production (rhud_app / NOBYPASSRLS). ' +
        'Refusing to fall back to DATABASE_URL, which would disable tenant RLS.',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }
  return parsed.data;
}
