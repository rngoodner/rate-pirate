/** Reset and re-seed the demo (mock) dataset: wipes mock-source rows only,
 *  then backfills N virtual days of synthetic history and deals.
 *  Live (google-flights/travelpayouts) data is untouched.
 *  Usage: npx tsx scripts/seed-history.ts [days]
 *  Note: with PROVIDER=mock, the server also auto-seeds on boot if no mock
 *  history exists — this script is only needed to force a fresh demo state. */
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/db.js';
import { activeDeals, purgeMockData, seedDestinations } from '../src/db/repo.js';
import { getSettings } from '../src/db/settings.js';
import { DESTINATION_CATALOG } from '../src/scanner/destinations.js';
import { seedDemoHistory } from '../src/demo/seed.js';

const days = Number(process.argv[2] ?? 14);
const config = loadConfig();
const db = openDb(config.DB_PATH);
seedDestinations(db, DESTINATION_CATALOG);

purgeMockData(db);
const { snapshots } = await seedDemoHistory(db, {
  days,
  homeAirport: getSettings(db, config).homeAirport,
  log: (line) => console.log(line),
});

const deals = activeDeals(db, 'mock');
console.log(`\nseeded ${snapshots} snapshots over ${days} days — ${deals.length} active demo deals`);
for (const d of deals.slice(0, 8)) {
  console.log(
    `  ${d.destination} ${d.travelMonth}: $${Math.round(d.bestPriceCents / 100)} ` +
      `(baseline $${Math.round(d.baselinePriceCents / 100)}, score ${d.score})`,
  );
}
