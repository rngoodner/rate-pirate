import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import {
  activeDealsWithPlace,
  apiCallsToday,
  expireDeal,
  expireDealsBeforeMonth,
  expireDealsNotSeen,
  expireDealsOutsideUniverse,
  getDeal,
  getDealByCombo,
  insertSnapshot,
  logEvent,
  recordApiCall,
  upsertPriceInsights,
} from '../db/repo.js';
import { getSettings } from '../db/settings.js';
import type { Candidate } from '../deals/detect.js';
import type { ExploreDestination, FlightPriceProvider } from '../providers/types.js';

/** Cap snapshots stored per fixed-date scan of one candidate (cheapest first). */
const MAX_SNAPSHOTS_PER_SCAN = 10;

export interface ScanDeps {
  db: Db;
  config: Config;
  provider: FlightPriceProvider;
  /** Injectable clock for the simulator. */
  now?: () => Date;
  /** Called after each scored candidate; deal detection + alerting hook in here. */
  onQuotes?: (cand: Candidate) => void | Promise<void>;
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
 *  check, run identical Explore searches (double-scraping Google), race the
 *  provider's browser launch, and race alert cooldowns into duplicate emails. */
let batchInFlight = false;

/** A Date whose UTC fields equal the server's LOCAL calendar — month boundaries
 *  (deal expiry) must roll at local midnight, not UTC, which is 5–6pm in
 *  America/Denver. Relies on the process running in the home airport's timezone
 *  (the systemd unit pins TZ=America/Denver; see deploy/). Virtual clocks
 *  (simulator) are used as-is. */
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
  // Expiry runs even while scanning is paused — a paused scanner must not leave
  // past-month / departed / out-of-universe deals sitting in the feed.
  expireDealsBeforeMonth(db, calRef.toISOString().slice(0, 7));
  const zombies = expireDealsOutsideUniverse(db, {
    source: provider.name,
    origin: settings.homeAirport,
    today: calRef.toISOString().slice(0, 10),
    cabins: settings.monitoredCabins,
    tripTypes: settings.tripTypes,
  });
  if (zombies > 0) {
    logEvent(db, {
      level: 'info',
      scope: 'batch',
      message: `expired ${zombies} deal${zombies === 1 ? '' : 's'} no longer scanned (departed, or outside the current airport/cabins/trip types)`,
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

  const budgetLeft = () =>
    settings.dailyCallBudget - apiCallsToday(db, provider.name, virtualClock ? sqliteStamp(now()) : undefined);
  // Cap candidates scored per batch so a cron batch spreads the day's work
  // (budget/4 by default, matching the 4 daily slots); an explicit limit wins.
  const scoreLimit = batchLimit ?? Math.ceil(settings.dailyCallBudget / 4);

  let scanned = 0;
  let snapshots = 0;
  let failures = 0;
  let planned = 0;
  const scannedCombos = new Set<string>();
  // Per-cabin tallies catch the failure mode where one cabin silently returns
  // zero prices for every candidate while other cabins keep the batch healthy.
  const byCabin = new Map<string, { scanned: number; snapshots: number }>();

  // One Explore search per (trip type, cabin) discovers a ranked destination
  // list; the fixed-date scraper then scores each candidate cheapest-first
  // until the daily budget runs out (the rest roll to the next cron batch).
  outer: for (const tripType of settings.tripTypes) {
    for (const cabin of settings.monitoredCabins) {
      if (budgetLeft() <= 0 || scanned >= scoreLimit) break outer;
      let destinations: ExploreDestination[];
      try {
        destinations = await provider.exploreSearch({
          origin: settings.homeAirport,
          cabin,
          tripType,
          adults: settings.adults,
        });
        recordMockCall(db, provider.name, `explore ${settings.homeAirport} ${cabin} ${tripType}`, 'exploreSearch', asOfNow(now));
      } catch (err) {
        failures++;
        logEvent(db, {
          level: 'error',
          scope: 'scan',
          message: `explore ${settings.homeAirport} ${cabin} ${tripType}: ${err instanceof Error ? err.message : String(err)}`,
          detail: err instanceof Error ? (err.stack ?? String(err)) : String(err),
          at: sqliteStamp(now()),
        });
        continue;
      }

      scannedCombos.add(`${cabin}|${tripType}`);
      planned += destinations.length;
      for (const d of destinations) {
        if (budgetLeft() <= 0 || scanned >= scoreLimit) break;
        const cand: Candidate = {
          source: provider.name,
          origin: settings.homeAirport,
          destination: d.iata,
          city: d.city,
          country: d.country,
          cabin,
          tripType,
        };
        try {
          const r = await scanCandidate(deps, cand, d, now);
          scanned++;
          snapshots += r.snapshots;
          const tally = byCabin.get(cabin) ?? { scanned: 0, snapshots: 0 };
          tally.scanned++;
          tally.snapshots += r.snapshots;
          byCabin.set(cabin, tally);
        } catch (err) {
          failures++;
          console.error(`scan failed for ${d.iata} ${tripType} ${cabin}:`, err);
          logEvent(db, {
            level: 'error',
            scope: 'scan',
            message: `${settings.homeAirport}→${d.iata} ${tripType} ${cabin}: ${err instanceof Error ? err.message : String(err)}`,
            detail: err instanceof Error ? (err.stack ?? String(err)) : String(err),
            at: sqliteStamp(now()),
          });
        }
      }
      // Inherent verification: a shown deal whose destination Explore no longer
      // ranks for this trip shape is gone. Only when Explore actually returned a
      // list — never nuke the feed on a transient empty/failed search.
      if (destinations.length > 0) {
        expireDealsNotSeen(
          db,
          provider.name,
          settings.homeAirport,
          cabin,
          tripType,
          destinations.map((x) => x.iata),
        );
      }
    }
  }

  // Safety net: re-price shown deals whose combo this batch never reached (budget
  // cut it off), so a moved/vanished fare still updates. Cheap — few active deals.
  const v = await verifyShownDeals(deps, settings, now, scannedCombos, budgetLeft);
  snapshots += v.snapshots;
  failures += v.failures;

  logEvent(db, {
    level: 'info',
    scope: 'batch',
    message:
      `batch: ${scanned}/${planned} candidates scored across ${scannedCombos.size} searches, ${snapshots} prices` +
      (failures ? `, ${failures} failed` : ''),
    at: sqliteStamp(now()),
  });
  // Anomaly: a sizable batch where every scan "succeeded" with zero prices is
  // the signature of Google changing its markup (or serving a non-English page).
  if (scanned >= 10 && snapshots === 0) {
    logEvent(db, {
      level: 'error',
      scope: 'batch',
      message: `possible scraper breakage: ${scanned} scans succeeded but returned zero prices — Google may have changed its page format`,
      at: sqliteStamp(now()),
    });
  } else {
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
  return { planned, scanned, snapshots, failures };
}

/** Price one Explore candidate at its exact dates and fold the result into the
 *  DB: insights, snapshots, and deal detection/alerting (via onQuotes). A
 *  candidate that returns no fares expires any deal it was backing. Throws on
 *  scrape failure so the caller can count/log it. */
async function scanCandidate(
  deps: ScanDeps,
  cand: Candidate,
  dates: { departDate: string; returnDate: string },
  now: () => Date,
): Promise<{ snapshots: number; hadQuotes: boolean }> {
  const { db, provider } = deps;
  const capturedAt = sqliteStamp(now());
  const { quotes, insights } = await provider.monthQuotes({
    origin: cand.origin,
    destination: cand.destination,
    cabin: cand.cabin,
    month: dates.departDate.slice(0, 7),
    departDate: dates.departDate,
    returnDate: dates.returnDate,
    // Google publishes the price history for the exact trip; always fetch it —
    // it's the baseline and the sparkline in the Explore model.
    wantHistory: true,
  });
  const insightsKey = {
    source: provider.name,
    origin: cand.origin,
    destination: cand.destination,
    cabin: cand.cabin,
    tripType: cand.tripType,
  };
  if (insights) {
    upsertPriceInsights(db, insightsKey, { level: insights.level, history: insights.history, capturedAt });
  }
  if (provider.name === 'mock') {
    recordApiCall(db, {
      provider: 'mock',
      endpoint: 'monthQuotes',
      route: `${cand.origin}-${cand.destination} ${cand.tripType} ${cand.cabin}`,
      ok: true,
      calledAt: capturedAt,
    });
  }
  let snapshots = 0;
  for (const q of quotes.slice(0, MAX_SNAPSHOTS_PER_SCAN)) {
    insertSnapshot(db, {
      source: provider.name,
      origin: q.origin,
      destination: q.destination,
      city: cand.city,
      country: cand.country,
      cabin: q.cabin,
      tripType: cand.tripType,
      travelMonth: q.departDate.slice(0, 7),
      departDate: q.departDate,
      returnDate: q.returnDate,
      priceCents: q.priceCents,
      stops: q.stops,
      carrier: q.carrier,
      capturedAt,
    });
    snapshots++;
  }
  if (quotes.length > 0) {
    await deps.onQuotes?.(cand); // detection: refresh or expire vs the floor
  } else {
    // No fares at all: any deal we were showing for this combo is gone.
    const existing = getDealByCombo(db, provider.name, cand.origin, cand.destination, cand.cabin, cand.tripType);
    if (existing?.status === 'active') expireDeal(db, existing.id);
  }
  return { snapshots, hadQuotes: quotes.length > 0 };
}

/** Re-price currently-shown deals whose (cabin, trip_type) combo wasn't scanned
 *  this batch, so a fare that has moved or vanished is refreshed/dropped.
 *  Budget-capped; the active-deal count is small so this is cheap. */
async function verifyShownDeals(
  deps: ScanDeps,
  settings: ReturnType<typeof getSettings>,
  now: () => Date,
  scannedCombos: Set<string>,
  budgetLeft: () => number,
): Promise<{ verified: number; dropped: number; snapshots: number; failures: number }> {
  const { db, provider } = deps;
  const toVerify = activeDealsWithPlace(db, provider.name, settings.monitoredCabins).filter(
    (d) => !scannedCombos.has(`${d.cabin}|${d.tripType}`),
  );
  let verified = 0;
  let dropped = 0;
  let snapshots = 0;
  let failures = 0;
  for (const d of toVerify) {
    if (budgetLeft() <= 0) break;
    const cand: Candidate = {
      source: provider.name,
      origin: d.origin,
      destination: d.destination,
      city: d.city,
      country: d.country,
      cabin: d.cabin,
      tripType: d.tripType,
    };
    try {
      const r = await scanCandidate(deps, cand, { departDate: d.departDate, returnDate: d.returnDate }, now);
      verified++;
      snapshots += r.snapshots;
      if (getDeal(db, d.id)?.status === 'expired') dropped++;
    } catch (err) {
      failures++;
      logEvent(db, {
        level: 'error',
        scope: 'scan',
        message: `verify ${d.origin}→${d.destination} ${d.tripType} ${d.cabin}: ${err instanceof Error ? err.message : String(err)}`,
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
 *  independent of a full batch. Shares the batch mutex and respects the budget. */
export async function runDealVerification(deps: ScanDeps): Promise<VerifyResult> {
  if (batchInFlight) return { verified: 0, dropped: 0, skippedReason: 'already_running' };
  batchInFlight = true;
  try {
    const { db, config, provider } = deps;
    const virtualClock = deps.now !== undefined;
    const now = deps.now ?? (() => new Date());
    const settings = getSettings(db, config);
    const budgetLeft = () =>
      settings.dailyCallBudget - apiCallsToday(db, provider.name, virtualClock ? sqliteStamp(now()) : undefined);
    if (budgetLeft() <= 0) return { verified: 0, dropped: 0, skippedReason: 'budget_exhausted' };
    // Empty scannedCombos → verify every shown deal.
    const { verified, dropped } = await verifyShownDeals(deps, settings, now, new Set(), budgetLeft);
    return { verified, dropped };
  } finally {
    batchInFlight = false;
  }
}

/** Record a call for the mock provider (the real provider logs its own). */
function recordMockCall(db: Db, providerName: string, route: string, endpoint: string, calledAt: string): void {
  if (providerName !== 'mock') return;
  recordApiCall(db, { provider: 'mock', endpoint, route, ok: true, calledAt });
}

function asOfNow(now: () => Date): string {
  return sqliteStamp(now());
}

export function sqliteStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
