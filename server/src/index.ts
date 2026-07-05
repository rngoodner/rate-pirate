import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { openDb } from './db/db.js';
import { seedDestinations } from './db/repo.js';
import { DESTINATION_CATALOG } from './scanner/destinations.js';
import { startScheduler } from './scanner/scheduler.js';
import { createProvider } from './providers/index.js';
import { createEmailSender } from './alerts/email.js';
import { createOnQuotes } from './pipeline.js';
import type { AppDeps } from './app.js';

const config = loadConfig();
const db = openDb(config.DB_PATH);
seedDestinations(db, DESTINATION_CATALOG);
const provider = createProvider(config, db);
const sender = createEmailSender(config);

const deps: AppDeps = {
  db,
  config,
  provider,
  sender,
  onQuotes: createOnQuotes(db, config, sender),
};
startScheduler(deps);

const app = createApp(deps);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(
    `rate-pirate server listening on http://localhost:${info.port} ` +
      `(provider: ${provider.name}, email: ${sender.name})`,
  );
});
