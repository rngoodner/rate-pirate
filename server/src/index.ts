import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { openDb } from './db/db.js';
import { purgeMockData, seedDestinations } from './db/repo.js';
import { getSettings } from './db/settings.js';
import { DESTINATION_CATALOG } from './scanner/destinations.js';
import { startScheduler } from './scanner/scheduler.js';
import { createProvider } from './providers/index.js';
import { createEmailSender } from './alerts/email.js';
import { createOnQuotes } from './pipeline.js';
import { needsDemoSeed, seedDemoHistory } from './demo/seed.js';
import type { AppDeps } from './app.js';

const config = loadConfig();
const db = openDb(config.DB_PATH);
seedDestinations(db, DESTINATION_CATALOG);
const provider = createProvider(config, db);
const sender = createEmailSender(config);

// Demo mode is self-contained: entering it seeds synthetic history so the UI
// has data immediately; leaving it purges every mock artifact so live data
// starts clean. Real history is never touched by either step.
if (provider.name === 'mock') {
  if (needsDemoSeed(db)) {
    purgeMockData(db); // clear partial/stale demo leftovers before reseeding
    const settings = getSettings(db, config);
    console.log('demo mode: seeding 14 days of synthetic price history…');
    const { snapshots, days } = await seedDemoHistory(db, {
      homeAirport: settings.homeAirport,
      cabins: settings.monitoredCabins,
    });
    console.log(`demo mode: seeded ${snapshots} snapshots over ${days} virtual days`);
  }
} else {
  const removed = purgeMockData(db);
  if (removed > 0) console.log(`live mode: purged ${removed} mock rows (demo data)`);
}

const deps: AppDeps = {
  db,
  config,
  provider,
  sender,
  onQuotes: createOnQuotes(db, config, sender, provider.name),
};
startScheduler(deps);

const app = createApp(deps);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(
    `rate-pirate server listening on http://localhost:${info.port} ` +
      `(provider: ${provider.name}, email: ${sender.name})`,
  );
});
