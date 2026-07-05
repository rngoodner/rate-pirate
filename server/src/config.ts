import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3789),
  DB_PATH: z.string().default('./data/rate-pirate.db'),
  PROVIDER: z.enum(['travelpayouts', 'mock']).optional(),
  TRAVELPAYOUTS_TOKEN: z.string().optional(),
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
