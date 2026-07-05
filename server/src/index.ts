import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { openDb } from './db/db.js';
import { seedDestinations } from './db/repo.js';
import { DESTINATION_CATALOG } from './scanner/destinations.js';
import { startScheduler } from './scanner/scheduler.js';
import type { ScanDeps } from './scanner/scan.js';
import { createProvider } from './providers/index.js';

const config = loadConfig();
const db = openDb(config.DB_PATH);
seedDestinations(db, DESTINATION_CATALOG);
const provider = createProvider(config, db);

const deps: ScanDeps = { db, config, provider };
startScheduler(deps);

const app = createApp(deps);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(
    `rate-pirate server listening on http://localhost:${info.port} (provider: ${provider.name})`,
  );
});
