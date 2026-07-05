/** Live smoke test of the Google Flights provider: a handful of real page
 *  loads across route types. Usage: npx tsx scripts/gf-smoke.ts [DEST ...] */
import { loadConfig } from '../src/config.js';
import { findChrome, GoogleFlightsProvider } from '../src/providers/google-flights.js';

const config = loadConfig();
const origin = process.env.HOME_AIRPORT ?? 'ABQ';
const destinations = process.argv.slice(2).length ? process.argv.slice(2) : ['NAP', 'CUN', 'LON', 'FAI'];
const month = (() => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 2);
  return d.toISOString().slice(0, 7);
})();

const provider = new GoogleFlightsProvider(findChrome(config.CHROME_PATH), (log) =>
  console.log(`  page ${log.route} -> ${log.ok ? 'ok' : 'FAIL'}`),
);

for (const destination of destinations) {
  try {
    const quotes = await provider.monthQuotes({ origin, destination, month });
    if (quotes.length === 0) {
      console.log(`${origin}-${destination} ${month}: no results`);
      continue;
    }
    const q = quotes[0]!;
    console.log(
      `${origin}-${destination} ${month}: $${q.priceCents / 100} ${q.departDate}→${q.returnDate} ` +
        `${q.stops} stop(s) ${q.carrier} (${quotes.length} quotes)`,
    );
  } catch (err) {
    console.error(`${origin}-${destination} ${month}: ERROR — ${err}`);
  }
}
await provider.close();
