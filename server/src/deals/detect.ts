import type { Cabin } from '@rate-pirate/shared';
import type { Db } from '../db/db.js';
import {
  expireDeal,
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
    // Corroboration from the scan page's own verdict (same scan as `current`).
    googleLevel: insights?.level ?? null,
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

/** Re-run detection for every route-month that has snapshots — purely stored
 *  data, zero provider calls. Used when the feed floor changes so the feed
 *  reflects it immediately: raising expires now-too-shallow deals, lowering
 *  resurrects qualifying ones from the latest scans. Alerting is NOT part of
 *  this path (a settings change must never send email). */
export function reevaluateDeals(
  db: Db,
  source: string,
  origin: string,
  minDiscount: number,
  asOf: string,
): { routeMonths: number } {
  const latest = latestCaptureByRouteMonth(db, source, origin);
  for (const key of latest.keys()) {
    const [destination, month, cabin] = key.split('|') as [string, string, Cabin];
    processRouteMonth(db, { source, origin, destination, cabin, month }, asOf, { minDiscount });
  }
  return { routeMonths: latest.size };
}
