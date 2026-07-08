import type { Cabin, TripType } from '@rate-pirate/shared';
import type { Db } from '../db/db.js';
import {
  expireDeal,
  expireDealsBeforeMonth,
  expireDealsOutsideUniverse,
  getDealByCombo,
  getPriceInsights,
  latestScanSnapshots,
  recentSnapshotCombos,
  upsertDeal,
  type DealRow,
} from '../db/repo.js';
import { computeBaseline } from './baseline.js';
import { scoreDeal } from './score.js';

/** A deal exists while the price sits this far under baseline (the Settings
 *  default; the live value comes from settings.dealMinDiscount). */
const DEFAULT_DEAL_MIN_DISCOUNT = 0.05;

/** How far back stored snapshots stay eligible to re-form a deal on a floor change. */
const REEVAL_WINDOW_DAYS = 60;

export interface Candidate {
  source: string;
  origin: string;
  destination: string;
  city: string;
  country: string;
  cabin: Cabin;
  tripType: TripType;
}

/** Re-evaluate one (destination, cabin, trip_type) combo after a scan wrote
 *  fresh snapshots + insights. Returns the active deal when one exists (created
 *  or refreshed), else null. */
export function processCandidate(
  db: Db,
  cand: Candidate,
  asOf: string,
  opts: { minDiscount?: number } = {},
): DealRow | null {
  const minDiscount = opts.minDiscount ?? DEFAULT_DEAL_MIN_DISCOUNT;
  const { source, origin, destination, cabin, tripType } = cand;
  const current = latestScanSnapshots(db, source, origin, destination, cabin, tripType, asOf)[0];
  const existing = getDealByCombo(db, source, origin, destination, cabin, tripType);
  if (!current) return null;

  const insights = getPriceInsights(db, source, origin, destination, cabin, tripType);
  const baseline = computeBaseline(insights);
  if (!baseline) return null; // no Google history yet: collect only

  const { score, discountPct } = scoreDeal({
    currentCents: current.priceCents,
    baselineCents: baseline.baselineCents,
    // Google's series is already daily-lowest prices — the percentile history
    // the score needs. Empty until a series is captured (median-only insights).
    routeHistoryCents: insights?.series.map((p) => p.priceCents) ?? [],
    // Corroboration from the scan page's own verdict — ONLY when it came from
    // the same scan as the current price (a stale 'low' left on a mature route
    // would otherwise nudge the score indefinitely).
    googleLevel: insights?.capturedAt === current.capturedAt ? insights.level : null,
  });

  if (discountPct > minDiscount) {
    return upsertDeal(db, {
      source,
      origin,
      destination,
      city: cand.city || current.city,
      country: cand.country || current.country,
      cabin,
      tripType,
      travelMonth: current.departDate.slice(0, 7),
      bestPriceCents: current.priceCents,
      baselinePriceCents: baseline.baselineCents,
      discountPct,
      score,
      departDate: current.departDate,
      returnDate: current.returnDate,
      seenAt: asOf,
      baselineSource: 'google',
    });
  }

  // Price recovered above the floor: retire any active deal for this combo.
  if (existing && existing.status === 'active') expireDeal(db, existing.id);
  return null;
}

/** Re-run detection for every combo with recent snapshots — purely stored data,
 *  zero provider calls. Used when the feed floor changes so the feed reflects it
 *  immediately: raising expires now-too-shallow deals, lowering resurrects
 *  qualifying ones from the latest scans. Alerting is NOT part of this path. */
export function reevaluateDeals(
  db: Db,
  source: string,
  origin: string,
  minDiscount: number,
  universe: { currentMonth: string; today: string; cabins: Cabin[]; tripTypes: TripType[] },
  asOf: string,
): { combos: number } {
  expireDealsBeforeMonth(db, universe.currentMonth);
  const combos = recentSnapshotCombos(db, source, origin, REEVAL_WINDOW_DAYS);
  for (const c of combos) {
    processCandidate(db, { source, origin, ...c }, asOf, { minDiscount });
  }
  // Sweep deals whose cheapest date pair has already departed / left the universe.
  expireDealsOutsideUniverse(db, {
    source,
    origin,
    today: universe.today,
    cabins: universe.cabins,
    tripTypes: universe.tripTypes,
  });
  return { combos: combos.length };
}
