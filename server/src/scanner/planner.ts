import type { Cabin } from '@rate-pirate/shared';
import type { DestinationRow } from '../db/repo.js';

export interface RouteMonthTask {
  destination: string;
  cabin: Cabin;
  month: string;
  tier: number;
}

const TIER_WEIGHT: Record<number, number> = { 1: 3, 2: 1.5, 3: 1 };
/** Staleness assigned to never-scanned route-months (hours). Large enough to
 *  outrank anything scanned recently, small enough not to swamp tier weights. */
const NEVER_SCANNED_HOURS = 1000;
/** Route-months scanned more recently than this are never re-planned; caps the
 *  cadence at roughly once per day per route-month. */
const MIN_STALE_HOURS = 18;

/** Departure months 'YYYY-MM' from +1 to +horizon relative to `now`. */
export function horizonMonths(now: Date, horizon: number): string[] {
  const months: string[] = [];
  for (let offset = 1; offset <= horizon; offset++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

/** Rank all route-months by staleness × tier weight × near-month boost and
 *  return the top `limit`. Under a generous budget this is simply "everything";
 *  under a tight one, favorites and near months cycle fastest. */
export function planBatch(opts: {
  destinations: DestinationRow[];
  /** Cabins to scan; the scan universe is destinations × months × cabins. */
  cabins: Cabin[];
  /** `${destination}|${month}|${cabin}` → latest captured_at (SQLite datetime). */
  latestCapture: Map<string, string>;
  now: Date;
  horizon: number;
  limit: number;
}): RouteMonthTask[] {
  if (opts.limit <= 0 || opts.cabins.length === 0) return [];
  const months = horizonMonths(opts.now, opts.horizon);

  const candidates = opts.destinations.flatMap((dest) =>
    months.flatMap((month, monthIdx) =>
      opts.cabins
        .map((cabin) => {
          const latest = opts.latestCapture.get(`${dest.iata}|${month}|${cabin}`);
          const staleHours = latest
            ? Math.max(0, (opts.now.getTime() - Date.parse(latest.replace(' ', 'T') + 'Z')) / 3_600_000)
            : NEVER_SCANNED_HOURS;
          const monthBoost = monthIdx < 3 ? 1.5 : 1;
          const priority = staleHours * (TIER_WEIGHT[dest.tier] ?? 1) * monthBoost;
          return { destination: dest.iata, cabin, month, tier: dest.tier, staleHours, priority };
        })
        .filter((c) => c.staleHours >= MIN_STALE_HOURS),
    ),
  );

  return candidates
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.tier - b.tier ||
        a.month.localeCompare(b.month) ||
        a.destination.localeCompare(b.destination) ||
        a.cabin.localeCompare(b.cabin),
    )
    .slice(0, opts.limit)
    .map(({ destination, cabin, month, tier }) => ({ destination, cabin, month, tier }));
}
