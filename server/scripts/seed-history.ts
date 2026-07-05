/** Backfills the dev DB with ~2 weeks of synthetic price history and deals so
 *  the UI has something to show. Usage: npx tsx scripts/seed-history.ts [days]
 *  Wipes existing snapshot/deal/alert/api_call rows first. */
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/db.js';
import { activeDeals, seedDestinations } from '../src/db/repo.js';
import { updateSettings } from '../src/db/settings.js';
import { DESTINATION_CATALOG } from '../src/scanner/destinations.js';
import { SyntheticProvider } from '../src/providers/mock.js';
import { runScanBatch } from '../src/scanner/scan.js';
import { createOnQuotes } from '../src/pipeline.js';
import type { EmailSender } from '../src/alerts/email.js';

const days = Number(process.argv[2] ?? 14);
const config = loadConfig();
const db = openDb(config.DB_PATH);
seedDestinations(db, DESTINATION_CATALOG);
db.exec('DELETE FROM price_snapshots; DELETE FROM deals; DELETE FROM alerts; DELETE FROM api_calls;');
updateSettings(db, { dailyCallBudget: 600 });

const START = Date.now() - days * 86_400_000;
let virtualNow = new Date(START);
const now = () => virtualNow;
const provider = new SyntheticProvider({ seed: 42, now });
const silentSender: EmailSender = { name: 'console', send: async () => {} };
const deps = { db, config, provider, now, onQuotes: createOnQuotes(db, config, silentSender, now) };

for (let day = 0; day < days; day++) {
  virtualNow = new Date(START + day * 86_400_000);
  const result = await runScanBatch(deps, 600);
  console.log(`day ${day + 1}/${days}: scanned=${result.scanned} snapshots=${result.snapshots}`);
}

const deals = activeDeals(db);
console.log(`\nseeded ${days} days of history — ${deals.length} active deals`);
for (const d of deals.slice(0, 8)) {
  console.log(
    `  ${d.destination} ${d.travelMonth}: $${Math.round(d.bestPriceCents / 100)} ` +
      `(baseline $${Math.round(d.baselinePriceCents / 100)}, score ${d.score})`,
  );
}
