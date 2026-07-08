import { CABINS, TRIP_TYPES, type Cabin, type TripType } from '@rate-pirate/shared';
import type { Db } from '../db/db.js';
import { insertSnapshot, upsertPriceInsights } from '../db/repo.js';
import { processCandidate } from '../deals/detect.js';
import { SyntheticProvider } from '../providers/mock.js';
import { sqliteStamp } from '../scanner/scan.js';

const DAY = 86_400_000;
const MAX_SNAPSHOTS_PER_SCAN = 10;

export interface SeedOptions {
  days?: number;
  homeAirport?: string;
  cabins?: Cabin[];
  tripTypes?: TripType[];
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
  // Seed every cabin and trip type so toggling them in the demo shows data
  // immediately, mirroring the live Explore-discover → fixed-date-score flow.
  const cabins = opts.cabins ?? [...CABINS];
  const tripTypes = opts.tripTypes ?? [...TRIP_TYPES];
  const start = Date.now() - days * DAY;

  let virtualNow = new Date(start);
  const provider = new SyntheticProvider({ seed: 42, now: () => virtualNow });

  let snapshots = 0;
  for (let day = 0; day < days; day++) {
    virtualNow = new Date(start + day * DAY);
    const asOf = sqliteStamp(virtualNow);
    for (const tripType of tripTypes) {
      for (const cabin of cabins) {
        const destinations = await provider.exploreSearch({ origin, cabin, tripType, adults: 1 });
        for (const d of destinations) {
          const { quotes, insights } = await provider.monthQuotes({
            origin,
            destination: d.iata,
            cabin,
            month: d.departDate.slice(0, 7),
            departDate: d.departDate,
            returnDate: d.returnDate,
            wantHistory: true,
          });
          if (insights) {
            upsertPriceInsights(
              db,
              { source: 'mock', origin, destination: d.iata, cabin, tripType },
              { level: insights.level, history: insights.history, capturedAt: asOf },
            );
          }
          for (const q of quotes.slice(0, MAX_SNAPSHOTS_PER_SCAN)) {
            insertSnapshot(db, {
              source: 'mock',
              origin: q.origin,
              destination: q.destination,
              city: d.city,
              country: d.country,
              cabin: q.cabin,
              tripType,
              travelMonth: q.departDate.slice(0, 7),
              departDate: q.departDate,
              returnDate: q.returnDate,
              priceCents: q.priceCents,
              stops: q.stops,
              carrier: q.carrier,
              durationMinutes: q.durationMinutes,
              layovers: q.layovers,
              capturedAt: asOf,
            });
            snapshots++;
          }
          if (quotes.length > 0) {
            processCandidate(
              db,
              { source: 'mock', origin, destination: d.iata, city: d.city, country: d.country, cabin, tripType },
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
