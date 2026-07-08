import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { openDb } from './db/db.js';
import { activeDealsWithPlace, logEvent, purgeMockData } from './db/repo.js';
import { getSettings } from './db/settings.js';
import { startScheduler } from './scanner/scheduler.js';
import { calendarRef, sqliteStamp } from './scanner/scan.js';
import { reevaluateDeals } from './deals/detect.js';
import { createProvider } from './providers/index.js';
import { createEmailSender } from './alerts/email.js';
import { createOnQuotes } from './pipeline.js';
import { needsDemoSeed, seedDemoHistory } from './demo/seed.js';
import type { AppDeps } from './app.js';

const config = loadConfig();
const db = openDb(config.DB_PATH);
const provider = createProvider(config, db);
const sender = createEmailSender(config);

// Demo mode is self-contained: entering it seeds synthetic history so the UI
// has data immediately; leaving it purges every mock artifact so live data
// starts clean. Real history is never touched by either step.
if (provider.name === 'mock') {
  if (needsDemoSeed(db)) {
    purgeMockData(db); // clear partial/stale demo leftovers before reseeding
    // Seed every cabin (not just the monitored ones) so switching cabins in the
    // demo shows data instantly, without a reseed.
    console.log('demo mode: seeding 14 days of synthetic price history (all cabins)…');
    const { snapshots, days } = await seedDemoHistory(db, {
      homeAirport: getSettings(db, config).homeAirport,
    });
    console.log(`demo mode: seeded ${snapshots} snapshots over ${days} virtual days`);
  }
} else {
  const removed = purgeMockData(db);
  if (removed > 0) console.log(`live mode: purged ${removed} mock rows (demo data)`);
}

// Warm start / recovery: re-derive the active feed from stored snapshots and
// baselines (no scraping) so a restart shows deals immediately instead of
// waiting for the first scan — and so deals left expired by a prior run (e.g.
// after a party-size change that outran its rescan) come back where the stored
// data still supports them. Purely local; never hits a provider.
{
  const s = getSettings(db, config);
  const cal = calendarRef(new Date());
  const { combos } = reevaluateDeals(
    db,
    provider.name,
    s.homeAirport,
    s.dealMinDiscount,
    {
      currentMonth: cal.toISOString().slice(0, 7),
      today: cal.toISOString().slice(0, 10),
      cabins: s.monitoredCabins,
      tripTypes: s.tripTypes,
    },
    sqliteStamp(new Date()),
  );
  const active = activeDealsWithPlace(db, provider.name, s.monitoredCabins, s.tripTypes).length;
  const msg = `startup: re-derived deals from stored data — ${combos} combos, ${active} active`;
  console.log(msg);
  logEvent(db, { level: 'info', scope: 'system', message: msg });
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
