import { CABINS, type Cabin } from '@rate-pirate/shared';
import type { Db } from '../db/db.js';
import { activeDestinations, insertSnapshot } from '../db/repo.js';
import { processRouteMonth } from '../deals/detect.js';
import { SyntheticProvider } from '../providers/mock.js';
import { horizonMonths } from '../scanner/planner.js';
import { sqliteStamp } from '../scanner/scan.js';

const DAY = 86_400_000;
const MAX_SNAPSHOTS_PER_SCAN = 10;

export interface SeedOptions {
  days?: number;
  homeAirport?: string;
  cabins?: Cabin[];
  log?: (line: string) => void;
}

/** Backfill deterministic synthetic price history (source='mock') and run deal
 *  detection over it, so the UI has a populated demo feed. Only touches
 *  mock-source rows — live data, if any, is untouched. No emails are sent. */
export async function seedDemoHistory(
  db: Db,
  opts: SeedOptions = {},
): Promise<{ snapshots: number; days: number }> {
  // One big transaction: this runs at boot before anything else touches the DB,
  // and per-row commits make ~40k inserts crawl on spinning disks.
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await seedDays(db, opts);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function seedDays(
  db: Db,
  opts: SeedOptions,
): Promise<{ snapshots: number; days: number }> {
  const days = opts.days ?? 14;
  const origin = opts.homeAirport ?? 'ABQ';
  // Seed every cabin so toggling cabins in the demo shows data immediately.
  const cabins = opts.cabins ?? [...CABINS];
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
        for (const cabin of cabins) {
          const { quotes } = await provider.monthQuotes({ origin, destination: dest.iata, cabin, month });
          for (const q of quotes.slice(0, MAX_SNAPSHOTS_PER_SCAN)) {
            insertSnapshot(db, {
              origin: q.origin,
              destination: q.destination,
              cabin: q.cabin,
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
            processRouteMonth(
              db,
              { source: 'mock', origin, destination: dest.iata, cabin, month },
              asOf,
            );
          }
        }
      }
    }
    opts.log?.(`demo seed: day ${day + 1}/${days}`);
  }
  return { snapshots, days };
}

/** True when the existing mock history can't support baselines for every cabin
 *  — fresh DB, leftover partial/economy-only data (e.g. pre-cabin snapshots), or
 *  a seed aged past the 60-day baseline window. Callers purge before reseeding. */
export function needsDemoSeed(db: Db): boolean {
  const stmt = db.prepare(
    `SELECT COUNT(DISTINCT date(captured_at)) AS n FROM price_snapshots
     WHERE source = 'mock' AND cabin = ? AND captured_at >= datetime('now', '-60 days')`,
  );
  return CABINS.some((cabin) => (stmt.get(cabin) as { n: number }).n < 10);
}
