import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// .env lives at the repo root; workspace scripts run with cwd=server/.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });
dotenv.config({ quiet: true }); // also honor a cwd-local .env if present

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3789),
  DB_PATH: z.string().default('./data/rate-pirate.db'),
  PROVIDER: z.enum(['google-flights', 'travelpayouts', 'mock']).optional(),
  TRAVELPAYOUTS_TOKEN: z.string().optional(),
  CHROME_PATH: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  ALERT_EMAIL_FROM: z.string().default('onboarding@resend.dev'),
  ALERT_EMAIL_TO: z.string().optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    // Default to the real provider only when a token is present.
    PROVIDER: parsed.PROVIDER ?? (parsed.TRAVELPAYOUTS_TOKEN ? 'travelpayouts' : 'mock'),
  };
}
