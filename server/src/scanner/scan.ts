import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import {
  activeDestinations,
  apiCallsToday,
  expireDealsBeforeMonth,
  insertSnapshot,
  latestCaptureByRouteMonth,
  recordApiCall,
} from '../db/repo.js';
import { getSettings } from '../db/settings.js';
import type { FlightPriceProvider, RoundTripQuote } from '../providers/types.js';
import { planBatch, type RouteMonthTask } from './planner.js';

/** Cap snapshots stored per scan of one route-month (cheapest first). */
const MAX_SNAPSHOTS_PER_SCAN = 10;

export interface ScanDeps {
  db: Db;
  config: Config;
  provider: FlightPriceProvider;
  /** Injectable clock for the simulator. */
  now?: () => Date;
  /** Called after each successful task; deal detection + alerting hook in here. */
  onQuotes?: (task: RouteMonthTask, quotes: RoundTripQuote[]) => void | Promise<void>;
}

export interface ScanResult {
  planned: number;
  scanned: number;
  snapshots: number;
  failures: number;
  skippedReason?: 'scan_disabled' | 'budget_exhausted';
}

export async function runScanBatch(deps: ScanDeps, batchLimit?: number): Promise<ScanResult> {
  const { db, config, provider } = deps;
  const now = deps.now ?? (() => new Date());
  const settings = getSettings(db, config);

  if (!settings.scanEnabled) {
    return { planned: 0, scanned: 0, snapshots: 0, failures: 0, skippedReason: 'scan_disabled' };
  }

  const asOf = sqliteStamp(now());
  expireDealsBeforeMonth(db, asOf.slice(0, 7));
  const used = apiCallsToday(db, provider.name, asOf);
  const remaining = settings.dailyCallBudget - used;
  if (remaining <= 0) {
    return { planned: 0, scanned: 0, snapshots: 0, failures: 0, skippedReason: 'budget_exhausted' };
  }

  const limit = Math.min(remaining, batchLimit ?? Math.ceil(settings.dailyCallBudget / 4));
  const tasks = planBatch({
    destinations: activeDestinations(db),
    cabins: settings.monitoredCabins,
    latestCapture: latestCaptureByRouteMonth(db, provider.name, settings.homeAirport),
    now: now(),
    horizon: settings.scanHorizonMonths,
    limit,
  });

  let scanned = 0;
  let snapshots = 0;
  let failures = 0;
  for (const task of tasks) {
    const capturedAt = sqliteStamp(now());
    try {
      const quotes = await provider.monthQuotes({
        origin: settings.homeAirport,
        destination: task.destination,
        cabin: task.cabin,
        month: task.month,
      });
      // The real provider logs its own calls (with HTTP status); the mock doesn't.
      if (provider.name === 'mock') {
        recordApiCall(db, {
          provider: 'mock',
          endpoint: 'monthQuotes',
          route: `${settings.homeAirport}-${task.destination} ${task.month} ${task.cabin}`,
          ok: true,
          calledAt: capturedAt,
        });
      }
      scanned++;
      for (const q of quotes.slice(0, MAX_SNAPSHOTS_PER_SCAN)) {
        insertSnapshot(db, {
          origin: q.origin,
          destination: q.destination,
          cabin: q.cabin,
          travelMonth: task.month,
          departDate: q.departDate,
          returnDate: q.returnDate,
          priceCents: q.priceCents,
          stops: q.stops,
          carrier: q.carrier,
          source: provider.name,
          capturedAt,
        });
        snapshots++;
      }
      if (quotes.length > 0) await deps.onQuotes?.(task, quotes);
    } catch (err) {
      failures++;
      console.error(`scan failed for ${task.destination} ${task.month} ${task.cabin}:`, err);
    }
  }

  return { planned: tasks.length, scanned, snapshots, failures };
}

export function sqliteStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
