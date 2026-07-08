import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import {
  activeDealsWithPlace,
  activeDestinations,
  apiCallsToday,
  captureDaysForRouteMonth,
  dormantRouteMonths,
  expireDeal,
  expireDealsBeforeMonth,
  expireDealsOutsideUniverse,
  getDeal,
  getDealByRouteMonth,
  insertSnapshot,
  latestCaptureByRouteMonth,
  logEvent,
  recordApiCall,
  recordScanOutcome,
  upsertPriceInsights,
} from '../db/repo.js';
import { BASELINE_WINDOWS } from '../deals/baseline.js';

/** A route-month-cabin resting after this many consecutive empty scans… */
const DORMANT_AFTER_EMPTY = 5;
/** …re-probed this often so new/seasonal service is picked back up. */
const REPROBE_AFTER_DAYS = 14;
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
 *  5–6pm in America/Denver. Relies on the process running in the home airport's
 *  timezone (the systemd unit pins TZ=America/Denver; see deploy/). Virtual
 *  clocks (simulator) are used as-is. */
export function calendarRef(d: Date, virtualClock = false): Date {
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
    dormant: dormantRouteMonths(
      db,
      provider.name,
      settings.homeAirport,
      DORMANT_AFTER_EMPTY,
      REPROBE_AFTER_DAYS,
      asOf,
    ),
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
    try {
      const r = await scanRouteMonth(deps, settings, task, now);
      scanned++;
      snapshots += r.snapshots;
      const tally = byCabin.get(task.cabin) ?? { scanned: 0, snapshots: 0 };
      tally.scanned++;
      tally.snapshots += r.snapshots;
      byCabin.set(task.cabin, tally);
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
        at: sqliteStamp(now()),
      });
    }
  }

  // Verify the deals the feed is currently showing whose route-month this batch
  // didn't already scan (below).
  const scannedKeys = new Set(tasks.map((t) => `${t.destination}|${t.month}|${t.cabin}`));
  const v = await verifyShownDeals(deps, settings, now, calRef, scannedKeys);
  snapshots += v.snapshots;
  failures += v.failures;

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

/** Scrape one route-month-cabin and fold the result into the DB: insights,
 *  snapshots, empty-streak state, and deal detection/alerting (via onQuotes).
 *  Throws on scrape failure so the caller can count/log it. Shared by the main
 *  batch loop and the shown-deal verification pass. */
async function scanRouteMonth(
  deps: ScanDeps,
  settings: ReturnType<typeof getSettings>,
  task: RouteMonthTask,
  now: () => Date,
): Promise<{ snapshots: number; hadQuotes: boolean }> {
  const { db, provider } = deps;
  const capturedAt = sqliteStamp(now());
  const key = {
    source: provider.name,
    origin: settings.homeAirport,
    destination: task.destination,
    cabin: task.cabin,
    travelMonth: task.month,
  };
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
    nights: settings.tripNights,
    departureDow: settings.departureDow,
    wantHistory,
  });
  if (insights) {
    upsertPriceInsights(db, key, { level: insights.level, history: insights.history, capturedAt });
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
  // Track empty streaks so reliably fare-less pairs go dormant (see planner).
  recordScanOutcome(db, key, quotes.length > 0, capturedAt);
  let snapshots = 0;
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
  if (quotes.length > 0) {
    await deps.onQuotes?.(task, quotes); // detection: refresh or expire vs the floor
  } else {
    // No fares at all: any deal we were showing for this route-month is gone.
    // (Detection can't do this — with zero quotes there's no fresh price to
    // compare.) Applies to the main loop and the verify pass alike.
    const existing = getDealByRouteMonth(db, provider.name, settings.homeAirport, task.destination, task.cabin, task.month);
    if (existing?.status === 'active') expireDeal(db, existing.id);
  }
  return { snapshots, hadQuotes: quotes.length > 0 };
}

/** Re-scrape currently-displayed deals (active, monitored cabin, in-horizon)
 *  whose route-month isn't in `scannedKeys`, so a fare that has since vanished
 *  is dropped and a moved price is refreshed. Fares present → normal detection;
 *  zero fares → scanRouteMonth expires the deal. Budget-capped; the active-deal
 *  count is small so this is cheap. */
async function verifyShownDeals(
  deps: ScanDeps,
  settings: ReturnType<typeof getSettings>,
  now: () => Date,
  calRef: Date,
  scannedKeys: Set<string>,
): Promise<{ verified: number; dropped: number; snapshots: number; failures: number }> {
  const { db, provider } = deps;
  const virtualClock = deps.now !== undefined;
  const horizon = new Set(horizonMonths(calRef, settings.scanHorizonMonths));
  const toVerify = activeDealsWithPlace(db, provider.name, settings.monitoredCabins).filter(
    (d) =>
      horizon.has(d.travelMonth) && !scannedKeys.has(`${d.destination}|${d.travelMonth}|${d.cabin}`),
  );
  let verified = 0;
  let dropped = 0;
  let snapshots = 0;
  let failures = 0;
  for (const d of toVerify) {
    const spent = apiCallsToday(db, provider.name, virtualClock ? sqliteStamp(now()) : undefined);
    if (spent >= settings.dailyCallBudget) break;
    const task: RouteMonthTask = { destination: d.destination, cabin: d.cabin, month: d.travelMonth, tier: 0 };
    try {
      const r = await scanRouteMonth(deps, settings, task, now);
      verified++;
      snapshots += r.snapshots;
      // scanRouteMonth expired it if fares vanished or recovered above the floor.
      if (getDeal(db, d.id)?.status === 'expired') dropped++;
    } catch (err) {
      failures++;
      logEvent(db, {
        level: 'error',
        scope: 'scan',
        message: `verify ${settings.homeAirport}→${d.destination} ${d.travelMonth} ${d.cabin}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        detail: err instanceof Error ? (err.stack ?? String(err)) : String(err),
        at: sqliteStamp(now()),
      });
    }
  }
  if (verified > 0) {
    logEvent(db, {
      level: 'info',
      scope: 'batch',
      message: `verified ${verified} shown deal${verified === 1 ? '' : 's'}${dropped ? `, dropped ${dropped} no longer available` : ''}`,
      at: sqliteStamp(now()),
    });
  }
  return { verified, dropped, snapshots, failures };
}

export interface VerifyResult {
  verified: number;
  dropped: number;
  skippedReason?: 'already_running' | 'budget_exhausted';
}

/** Re-scrape every currently-shown deal on demand (Advanced → re-check deals),
 *  independent of a full batch. Shares the batch mutex so it can't overlap a
 *  scan, and respects the daily budget. */
export async function runDealVerification(deps: ScanDeps): Promise<VerifyResult> {
  if (batchInFlight) return { verified: 0, dropped: 0, skippedReason: 'already_running' };
  batchInFlight = true;
  try {
    const { db, config, provider } = deps;
    const virtualClock = deps.now !== undefined;
    const now = deps.now ?? (() => new Date());
    const settings = getSettings(db, config);
    const spent = apiCallsToday(db, provider.name, virtualClock ? sqliteStamp(now()) : undefined);
    if (spent >= settings.dailyCallBudget) return { verified: 0, dropped: 0, skippedReason: 'budget_exhausted' };
    const calRef = calendarRef(now(), virtualClock);
    const { verified, dropped } = await verifyShownDeals(deps, settings, now, calRef, new Set());
    return { verified, dropped };
  } finally {
    batchInFlight = false;
  }
}

export function sqliteStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
