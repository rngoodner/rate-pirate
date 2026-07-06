import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// .env lives at the repo root; workspace scripts run with cwd=server/.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });
dotenv.config({ quiet: true }); // also honor a cwd-local .env if present

// Env vars are strings; coerce.boolean() would treat "false" as true (non-empty),
// so parse booleans explicitly.
const envBool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3789),
  DB_PATH: z.string().default('./data/rate-pirate.db'),
  // 'google-flights' = live scraping; 'mock' = synthetic demo data.
  PROVIDER: z.enum(['google-flights', 'mock']).default('mock'),
  CHROME_PATH: z.string().optional(),
  /** Escape hatch: set true if Chromium refuses to launch without --no-sandbox
   *  (containers, exotic kernels). Sandboxed is the safer default. */
  CHROME_NO_SANDBOX: envBool,
  // SMTP (e.g. Proton Bridge). When SMTP_HOST is set it takes precedence over Resend.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** false = STARTTLS (Proton Bridge on 1025); true = implicit TLS. */
  SMTP_SECURE: envBool,
  /** Proton Bridge uses a localhost self-signed cert — allow it. */
  SMTP_ALLOW_INVALID_CERT: envBool,
  RESEND_API_KEY: z.string().optional(),
  ALERT_EMAIL_FROM: z.string().default('onboarding@resend.dev'),
  ALERT_EMAIL_TO: z.string().optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return envSchema.parse(env);
}
