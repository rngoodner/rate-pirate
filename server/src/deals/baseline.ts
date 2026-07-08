import type { PriceInsightsRow } from '../db/repo.js';

export interface Baseline {
  baselineCents: number;
  kind: 'google';
}

/** Baseline for a (destination, cabin, trip_type) combo: the median of Google's
 *  ~60-day price-history series for the exact trip, captured from the results
 *  page. Google publishes a daily-lowest-price series, so a deal can be scored
 *  from day one — no locally-accumulated history needed. Returns null until a
 *  median has been captured. */
export function computeBaseline(insights?: PriceInsightsRow | null): Baseline | null {
  // A non-positive median is never a real fare — reject it so scoreDeal can't
  // divide by zero (discountPct = (baseline-current)/baseline).
  if (insights?.medianCents != null && insights.medianCents > 0) {
    return { baselineCents: insights.medianCents, kind: 'google' };
  }
  return null;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
