import type { Db } from '../db/db.js';
import { activeDestinations, insertSnapshot } from '../db/repo.js';
import { processRouteMonth } from '../deals/detect.js';
import { SyntheticProvider } from '../providers/mock.js';
import { horizonMonths } from '../scanner/planner.js';
import { sqliteStamp } from '../scanner/scan.js';

const DAY = 86_400_000;
const MAX_SNAPSHOTS_PER_SCAN = 10;

/** Backfill deterministic synthetic price history (source='mock') and run deal
 *  detection over it, so the UI has a populated demo feed. Only touches
 *  mock-source rows — live data, if any, is untouched. No emails are sent. */
export async function seedDemoHistory(
  db: Db,
  opts: { days?: number; homeAirport?: string; log?: (line: string) => void } = {},
): Promise<{ snapshots: number; days: number }> {
  const days = opts.days ?? 14;
  const origin = opts.homeAirport ?? 'ABQ';
  const destinations = activeDestinations(db);
  const start = Date.now() - days * DAY;

  let virtualNow = new Date(start);
  const provider = new SyntheticProvider({ seed: 42, now: () => virtualNow });

  let snapshots = 0;
  for (let day = 0; day < days; day++) {
    virtualNow = new Date(start + day * DAY);
    const asOf = sqliteStamp(virtualNow);
    const months = horizonMonths(virtualNow, 6);
    for (const dest of destinations) {
      for (const month of months) {
        const quotes = await provider.monthQuotes({ origin, destination: dest.iata, month });
        for (const q of quotes.slice(0, MAX_SNAPSHOTS_PER_SCAN)) {
          insertSnapshot(db, {
            origin: q.origin,
            destination: q.destination,
            travelMonth: month,
            departDate: q.departDate,
            returnDate: q.returnDate,
            priceCents: q.priceCents,
            stops: q.stops,
            carrier: q.carrier,
            source: 'mock',
            capturedAt: asOf,
          });
          snapshots++;
        }
        if (quotes.length > 0) {
          processRouteMonth(db, { source: 'mock', origin, destination: dest.iata, month }, asOf);
        }
      }
    }
    opts.log?.(`demo seed: day ${day + 1}/${days}`);
  }
  return { snapshots, days };
}

/** True when no mock history exists yet (fresh DB or after a purge). */
export function needsDemoSeed(db: Db): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM price_snapshots WHERE source = 'mock'`)
    .get() as { n: number };
  return row.n === 0;
}
