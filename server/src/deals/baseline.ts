import type { PriceInsightsRow } from '../db/repo.js';

export interface Baseline {
  baselineCents: number;
  kind: 'google';
}

/** Baseline for a (destination, cabin, trip_type) combo: the median of Google's
 *  own ~60-day price-history series, captured from the deal's results page.
 *
 *  In the Explore model we no longer accumulate our own per-route history to
 *  build a baseline — Google already publishes a daily-lowest-price series for
 *  the exact trip, so a deal can be scored from day one. Returns null until a
 *  series (or at least a median) has been captured. */
export function computeBaseline(insights?: PriceInsightsRow | null): Baseline | null {
  if (insights?.medianCents != null) {
    return { baselineCents: insights.medianCents, kind: 'google' };
  }
  return null;
}

/** Cheapest observed price per capture day — the sparkline's daily-minima basis. */
export function dailyMinima(series: { capturedAt: string; priceCents: number }[]): number[] {
  const byDay = new Map<string, number>();
  for (const s of series) {
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
