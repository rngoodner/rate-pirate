/** One-off capture of real Travelpayouts responses into providers/fixtures/.
 *  Usage: TRAVELPAYOUTS_TOKEN=... npx tsx scripts/record-fixtures.ts [DEST ...]
 *  Defaults to 3 routes × 2 months ≈ 6 calls. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TravelpayoutsProvider } from '../src/providers/travelpayouts.js';

const token = process.env.TRAVELPAYOUTS_TOKEN;
if (!token) {
  console.error('TRAVELPAYOUTS_TOKEN is required');
  process.exit(1);
}

const origin = process.env.HOME_AIRPORT ?? 'ABQ';
const destinations = process.argv.slice(2).length ? process.argv.slice(2) : ['NAP', 'CUN', 'LON'];
const months = [1, 2].map((offset) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 7);
});

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/providers/fixtures');
mkdirSync(fixturesDir, { recursive: true });

const provider = new TravelpayoutsProvider(token, (log) =>
  console.log(`  call ${log.route} -> ${log.status ?? 'ERR'}`),
);

for (const destination of destinations) {
  for (const month of months) {
    const q = { origin, destination, month };
    try {
      const raw = await provider.fetchRaw(q);
      const file = join(fixturesDir, `${origin}-${destination}-${month}.json`);
      writeFileSync(file, JSON.stringify(raw, null, 2));
      console.log(`${origin}-${destination} ${month}: ${raw.data?.length ?? 0} tickets -> ${file}`);
    } catch (err) {
      console.error(`${origin}-${destination} ${month}: FAILED — ${err}`);
    }
  }
}
