import type { Cabin } from '@rate-pirate/shared';
import type { Db } from '../db/db.js';
import {
  expireDeal,
  expireDealsBeforeMonth,
  expireDealsOutsideUniverse,
  getDealByRouteMonth,
  getPriceInsights,
  latestCaptureByRouteMonth,
  latestScanSnapshots,
  snapshotsForRoute,
  snapshotsForRouteMonth,
  upsertDeal,
  type DealRow,
} from '../db/repo.js';
import { BASELINE_WINDOWS, computeBaseline, dailyMinima } from './baseline.js';
import { scoreDeal } from './score.js';

/** A deal exists while the price sits this far under baseline (the Settings
 *  default; the live value comes from settings.dealMinDiscount). */
const DEFAULT_DEAL_MIN_DISCOUNT = 0.05;

/** Re-evaluate one route-month after a scan wrote fresh snapshots.
 *  Returns the active deal when one exists (created or refreshed), else null. */
export function processRouteMonth(
  db: Db,
  route: { source: string; origin: string; destination: string; cabin: Cabin; month: string },
  asOf: string,
  opts: { minDiscount?: number } = {},
): DealRow | null {
  const minDiscount = opts.minDiscount ?? DEFAULT_DEAL_MIN_DISCOUNT;
  const { source, origin, destination, cabin, month } = route;
  const current = latestScanSnapshots(db, source, origin, destination, cabin, month, asOf)[0];
  const existing = getDealByRouteMonth(db, source, origin, destination, cabin, month);
  if (!current) return null;

  const monthHistory = snapshotsForRouteMonth(
    db,
    source,
    origin,
    destination,
    cabin,
    month,
    BASELINE_WINDOWS.MONTH_WINDOW_DAYS,
    asOf,
  );
  const routeHistory = snapshotsForRoute(
    db,
    source,
    origin,
    destination,
    cabin,
    BASELINE_WINDOWS.ROUTE_WINDOW_DAYS,
    asOf,
  );

  const insights = getPriceInsights(db, source, origin, destination, cabin, month);
  const baseline = computeBaseline(monthHistory, routeHistory, insights);
  if (!baseline) return null; // cold start with no insights either: collect only

  const { score, discountPct } = scoreDeal({
    currentCents: current.priceCents,
    baselineCents: baseline.baselineCents,
    // Daily minima, like the baseline — see computeBaseline for why. When the
    // baseline is bootstrapped from Google, its series (already daily lowest
    // prices) provides the percentile history our own thin data can't.
    routeHistoryCents:
      baseline.kind === 'google'
        ? (insights?.series.map((p) => p.priceCents) ?? [])
        : dailyMinima(routeHistory),
    // Corroboration from the scan page's own verdict — ONLY when it came from
    // the same scan as the current price. Google often drops the price badge on
    // mature routes, leaving a weeks-old level in the row; applying that stale
    // verdict would nudge the score indefinitely (a stale 'low' could inflate a
    // deal across the alert threshold).
    googleLevel: insights?.capturedAt === current.capturedAt ? insights.level : null,
  });

  if (discountPct > minDiscount) {
    return upsertDeal(db, {
      source,
      origin,
      destination,
      cabin,
      travelMonth: month,
      bestPriceCents: current.priceCents,
      baselinePriceCents: baseline.baselineCents,
      discountPct,
      score,
      departDate: current.departDate,
      returnDate: current.returnDate,
      seenAt: asOf,
      baselineSource: baseline.kind === 'google' ? 'google' : 'observed',
    });
  }

  // Price recovered: retire any active deal for this route-month.
  if (existing && existing.status === 'active') expireDeal(db, existing.id);
  return null;
}

/** Re-run detection for every current-or-future route-month that has snapshots
 *  — purely stored data, zero provider calls. Used when the feed floor changes
 *  so the feed reflects it immediately: raising expires now-too-shallow deals,
 *  lowering resurrects qualifying ones from the latest scans. Alerting is NOT
 *  part of this path (a settings change must never send email).
 *
 *  Mirrors the scan path's expiry so it can't revive a dead deal: snapshots
 *  persist ~180 days by capture date, long after a travel month passes, so
 *  past/out-of-horizon route-months are skipped and the same expiry sweep runs
 *  (departed dates, past months, out-of-universe). */
export function reevaluateDeals(
  db: Db,
  source: string,
  origin: string,
  minDiscount: number,
  window: { currentMonth: string; lastMonth: string; today: string },
  asOf: string,
): { routeMonths: number } {
  expireDealsBeforeMonth(db, window.currentMonth);
  const latest = latestCaptureByRouteMonth(db, source, origin);
  let routeMonths = 0;
  for (const key of latest.keys()) {
    const [destination, month, cabin] = key.split('|') as [string, string, Cabin];
    // 'YYYY-MM' compares lexically. Skip past and beyond-horizon months so a
    // stale snapshot can't re-activate a deal the scanner would never re-visit.
    if (month < window.currentMonth || month > window.lastMonth) continue;
    processRouteMonth(db, { source, origin, destination, cabin, month }, asOf, { minDiscount });
    routeMonths++;
  }
  // Catch current-month deals whose cheapest date-pair has already departed.
  expireDealsOutsideUniverse(db, { source, origin, lastMonth: window.lastMonth, today: window.today });
  return { routeMonths };
}
