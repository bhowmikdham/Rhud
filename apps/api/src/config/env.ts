import { z } from 'zod';

// Runtime env schema. Fail fast on boot if something is missing or malformed.
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(8000),
  API_CORS_ORIGIN: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().url(),
  // Runtime DB URL — connects as rhud_app (NOBYPASSRLS). Falls back to
  // DATABASE_URL if unset, which is fine for local first-runs but you'll
  // see RLS leaks until you set the dedicated runtime URL. CI sets both.
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
