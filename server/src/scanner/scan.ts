import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import {
  activeDestinations,
  apiCallsToday,
  captureDaysForRouteMonth,
  expireDealsBeforeMonth,
  expireDealsOutsideUniverse,
  insertSnapshot,
  latestCaptureByRouteMonth,
  logEvent,
  recordApiCall,
  upsertPriceInsights,
} from '../db/repo.js';
import { BASELINE_WINDOWS } from '../deals/baseline.js';
import { getSettings } from '../db/settings.js';
import type { FlightPriceProvider, RoundTripQuote } from '../providers/types.js';
import { horizonMonths, planBatch, type RouteMonthTask } from './planner.js';

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
  skippedReason?: 'scan_disabled' | 'budget_exhausted' | 'already_running';
}

/** One batch at a time, process-wide. Overlapping batches (manual POST /api/scan
 *  during a cron batch, boot catch-up near a cron slot) would race the budget
 *  check, plan identical task lists (double-scraping Google), race the provider's
 *  browser launch, and race alert cooldowns into duplicate emails. */
let batchInFlight = false;

/** A Date whose UTC fields equal the server's LOCAL calendar — month boundaries
 *  (deal expiry, scan horizon) must roll at local midnight, not UTC, which is
 *  5–6pm in America/Denver. Virtual clocks (simulator) are used as-is. */
function calendarRef(d: Date, virtualClock: boolean): Date {
  return virtualClock ? d : new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
}

export async function runScanBatch(deps: ScanDeps, batchLimit?: number): Promise<ScanResult> {
  if (batchInFlight) {
    return { planned: 0, scanned: 0, snapshots: 0, failures: 0, skippedReason: 'already_running' };
  }
  batchInFlight = true;
  try {
    return await runBatch(deps, batchLimit);
  } finally {
    batchInFlight = false;
  }
}

async function runBatch(deps: ScanDeps, batchLimit?: number): Promise<ScanResult> {
  const { db, config, provider } = deps;
  const virtualClock = deps.now !== undefined;
  const now = deps.now ?? (() => new Date());
  const settings = getSettings(db, config);

  const asOf = sqliteStamp(now());
  const calRef = calendarRef(now(), virtualClock);
  const months = horizonMonths(calRef, settings.scanHorizonMonths);
  // Expiry runs even while scanning is paused — a paused scanner must not
  // leave past-month/departed deals sitting in the feed indefinitely.
  expireDealsBeforeMonth(db, calRef.toISOString().slice(0, 7));
  // Deals the scanner will never re-visit must not linger with stale prices.
  const zombies = expireDealsOutsideUniverse(db, {
    source: provider.name,
    origin: settings.homeAirport,
    lastMonth: months[months.length - 1]!,
    today: calRef.toISOString().slice(0, 10),
  });
  if (zombies > 0) {
    logEvent(db, {
      level: 'info',
      scope: 'batch',
      message: `expired ${zombies} deal${zombies === 1 ? '' : 's'} no longer scanned (departed, or outside the current airport/horizon)`,
      at: asOf,
    });
  }

  if (!settings.scanEnabled) {
    logEvent(db, { level: 'info', scope: 'batch', message: 'batch skipped: scanning is off', at: asOf });
    return { planned: 0, scanned: 0, snapshots: 0, failures: 0, skippedReason: 'scan_disabled' };
  }

  // Real clock: count against the LOCAL day (apiCallsToday's no-asOf branch);
  // the asOf branch exists for the simulator's virtual timestamps only.
  const used = apiCallsToday(db, provider.name, virtualClock ? asOf : undefined);
  const remaining = settings.dailyCallBudget - used;
  if (remaining <= 0) {
    logEvent(db, {
      level: 'info',
      scope: 'batch',
      message: `batch skipped: daily budget spent (${used}/${settings.dailyCallBudget})`,
      at: asOf,
    });
    return { planned: 0, scanned: 0, snapshots: 0, failures: 0, skippedReason: 'budget_exhausted' };
  }

  const limit = Math.min(remaining, batchLimit ?? Math.ceil(settings.dailyCallBudget / 4));
  const tasks = planBatch({
    destinations: activeDestinations(db),
    cabins: settings.monitoredCabins,
    latestCapture: latestCaptureByRouteMonth(db, provider.name, settings.homeAirport),
    now: now(),
    monthsNow: calRef,
    horizon: settings.scanHorizonMonths,
    limit,
  });

  let scanned = 0;
  let snapshots = 0;
  let failures = 0;
  // Per-cabin tallies catch the failure mode where one cabin silently returns
  // zero prices for every route (e.g. a query format Google stops honoring)
  // while other cabins keep the batch looking healthy.
  const byCabin = new Map<string, { scanned: number; snapshots: number }>();
  for (const task of tasks) {
    // Re-check the budget each task: the plan-time count doesn't include the
    // calls this batch has since made (retries log an extra call each), so a
    // transient-heavy batch could otherwise overshoot the daily cap.
    const spent = apiCallsToday(db, provider.name, virtualClock ? sqliteStamp(now()) : undefined);
    if (spent >= settings.dailyCallBudget) {
      logEvent(db, {
        level: 'info',
        scope: 'batch',
        message: `batch stopped early: daily budget spent (${spent}/${settings.dailyCallBudget})`,
        at: sqliteStamp(now()),
      });
      break;
    }
    const capturedAt = sqliteStamp(now());
    try {
      // Fetch Google's history graph only while this route-month lacks its own
      // baseline — the click cost decays to ~zero as real history accumulates.
      const wantHistory =
        captureDaysForRouteMonth(
          db,
          provider.name,
          settings.homeAirport,
          task.destination,
          task.cabin,
          task.month,
          BASELINE_WINDOWS.MONTH_WINDOW_DAYS,
        ) < BASELINE_WINDOWS.MONTH_MIN_DAYS;
      const { quotes, insights } = await provider.monthQuotes({
        origin: settings.homeAirport,
        destination: task.destination,
        cabin: task.cabin,
        month: task.month,
        wantHistory,
      });
      if (insights) {
        upsertPriceInsights(
          db,
          {
            source: provider.name,
            origin: settings.homeAirport,
            destination: task.destination,
            cabin: task.cabin,
            travelMonth: task.month,
          },
          { level: insights.level, history: insights.history, capturedAt },
        );
      }
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
      const tally = byCabin.get(task.cabin) ?? { scanned: 0, snapshots: 0 };
      tally.scanned++;
      tally.snapshots += Math.min(quotes.length, MAX_SNAPSHOTS_PER_SCAN);
      byCabin.set(task.cabin, tally);
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
      logEvent(db, {
        level: 'error',
        scope: 'scan',
        message: `${settings.homeAirport}→${task.destination} ${task.month} ${task.cabin}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        detail: err instanceof Error ? (err.stack ?? String(err)) : String(err),
        at: capturedAt,
      });
    }
  }

  logEvent(db, {
    level: 'info',
    scope: 'batch',
    message:
      `batch: ${scanned}/${tasks.length} route-months scanned, ${snapshots} prices` +
      (failures ? `, ${failures} failed` : ''),
    at: sqliteStamp(now()),
  });
  // Anomaly: a sizable batch where every scan "succeeded" with zero prices is
  // the signature of Google changing its markup (or serving a non-English
  // page) — each page load reports ok, so without this check the breakage is
  // invisible while baselines silently age out. Individual no-flight routes
  // are normal; a whole batch of them is not.
  if (scanned >= 10 && snapshots === 0) {
    logEvent(db, {
      level: 'error',
      scope: 'batch',
      message: `possible scraper breakage: ${scanned} scans succeeded but returned zero prices — Google may have changed its page format`,
      at: sqliteStamp(now()),
    });
  } else {
    // Per-cabin variant: a cabin with a decent sample but zero prices while
    // the batch overall is healthy — e.g. its query format stopped working.
    for (const [cabin, t] of byCabin) {
      if (t.scanned >= 8 && t.snapshots === 0) {
        logEvent(db, {
          level: 'error',
          scope: 'batch',
          message: `no ${cabin} prices in ${t.scanned} scans — that cabin may be broken while others work`,
          at: sqliteStamp(now()),
        });
      }
    }
  }
  return { planned: tasks.length, scanned, snapshots, failures };
}

export function sqliteStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
