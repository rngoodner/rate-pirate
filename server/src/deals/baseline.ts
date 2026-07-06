import type { PriceInsightsRow, SnapshotRow } from '../db/repo.js';

export interface Baseline {
  baselineCents: number;
  kind: 'month' | 'route' | 'google';
}

const MONTH_WINDOW_DAYS = 60;
const MONTH_MIN_DAYS = 10;
const ROUTE_WINDOW_DAYS = 90;
const ROUTE_MIN_DAYS = 14;

export const BASELINE_WINDOWS = { MONTH_WINDOW_DAYS, ROUTE_WINDOW_DAYS, MONTH_MIN_DAYS };

/** Baseline for a route-month: median of the month's recent DAILY-CHEAPEST
 *  prices when deep enough, falling back to the whole route's, then to the
 *  median of Google's own ~60-day price-history series (captured from the
 *  same scan page) so deals can exist from day one, else null.
 *
 *  Daily minima, not raw snapshots: each scan stores several date-pair quotes,
 *  and the "current price" compared against the baseline is the cheapest of
 *  the latest scan. A median over all quotes would sit structurally above any
 *  day's cheapest, making every route look ~10% discounted forever. (Google's
 *  series is already daily lowest prices, so it's the same basis.) */
export function computeBaseline(
  monthSnapshots: SnapshotRow[],
  routeSnapshots: SnapshotRow[],
  insights?: PriceInsightsRow | null,
): Baseline | null {
  const monthDaily = dailyMinima(monthSnapshots);
  if (monthDaily.length >= MONTH_MIN_DAYS) {
    return { baselineCents: median(monthDaily), kind: 'month' };
  }
  const routeDaily = dailyMinima(routeSnapshots);
  if (routeDaily.length >= ROUTE_MIN_DAYS) {
    return { baselineCents: median(routeDaily), kind: 'route' };
  }
  if (insights?.medianCents != null) {
    return { baselineCents: insights.medianCents, kind: 'google' };
  }
  return null;
}

/** Cheapest observed price per capture day. */
export function dailyMinima(snapshots: SnapshotRow[]): number[] {
  const byDay = new Map<string, number>();
  for (const s of snapshots) {
    const day = s.capturedAt.slice(0, 10);
    const min = byDay.get(day);
    if (min === undefined || s.priceCents < min) byDay.set(day, s.priceCents);
  }
  return [...byDay.values()];
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
