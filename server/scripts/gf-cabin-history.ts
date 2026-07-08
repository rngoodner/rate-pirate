/** Diagnose why premium economy yields no baselines: for each route, price the
 *  SAME fixed weekend across economy / premium_economy / business with history
 *  enabled, and report quotes + price level + history-point count. If premium
 *  economy alone returns <10 history points, the baseline (median) goes NULL and
 *  no deal can form. Usage: npx tsx scripts/gf-cabin-history.ts [DEST ...] */
import { loadConfig } from '../src/config.js';
import { findChrome, GoogleFlightsProvider } from '../src/providers/google-flights.js';
import type { Cabin } from '@rate-pirate/shared';

const config = loadConfig();
const origin = process.env.HOME_AIRPORT ?? 'ABQ';
// Mix of short-haul domestic and long-haul international (where premium economy
// is an actual product) to see if the gap is route-dependent.
const destinations = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['LAX', 'JFK', 'LON', 'CDG', 'CUN'];
const departDate = process.env.DEPART ?? '2026-08-21';
const returnDate = process.env.RETURN ?? '2026-08-25';
const cabins: Cabin[] = ['economy', 'premium_economy', 'business'];

const provider = new GoogleFlightsProvider(findChrome(config.CHROME_PATH));

console.log(`ABQ dates ${departDate}→${returnDate}\n`);
for (const destination of destinations) {
  for (const cabin of cabins) {
    try {
      const { quotes, insights } = await provider.monthQuotes({
        origin,
        destination,
        cabin,
        month: departDate.slice(0, 7),
        departDate,
        returnDate,
        wantHistory: true,
      });
      const cheapest = quotes[0] ? `$${quotes[0].priceCents / 100}` : 'no-results';
      // Prefer history; fall back to the Price graph (premium economy).
      const series = insights?.history?.length ? insights.history : (insights?.priceGraph ?? []);
      const source = insights?.history?.length ? 'history' : insights?.priceGraph?.length ? 'graph' : 'none';
      const median = series.length
        ? '$' + [...series.map((h) => h.priceCents)].sort((a, b) => a - b)[Math.floor(series.length / 2)]! / 100
        : 'NULL';
      console.log(
        `${destination.padEnd(4)} ${cabin.padEnd(16)} ${String(cheapest).padEnd(10)} ` +
          `level=${(insights?.level ?? 'none').padEnd(8)} ${source.padEnd(7)}=${String(series.length).padStart(2)}pts median=${median}`,
      );
    } catch (err) {
      console.log(`${destination.padEnd(4)} ${cabin.padEnd(16)} ERROR — ${err}`);
    }
  }
  console.log('');
}
await provider.close();
