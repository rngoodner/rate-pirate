export interface ScoreInput {
  currentCents: number;
  baselineCents: number;
  /** Route-wide price history (all months) over the last 90 days. */
  routeHistoryCents: number[];
}

export interface ScoreResult {
  /** 0–100. */
  score: number;
  /** 0..1 fraction below baseline (negative = above baseline). */
  discountPct: number;
  /** 0..1 fraction of history strictly more expensive than the current price. */
  percentile: number;
}

/** A price 40% below baseline that undercuts all recent history scores ~100;
 *  a price at the median scores ~50. */
export function scoreDeal(input: ScoreInput): ScoreResult {
  const { currentCents, baselineCents, routeHistoryCents } = input;
  const percentile =
    routeHistoryCents.length === 0
      ? 0
      : routeHistoryCents.filter((p) => p > currentCents).length / routeHistoryCents.length;
  const discountPct = (baselineCents - currentCents) / baselineCents;
  const score = Math.round(100 * (0.6 * percentile + 0.4 * clamp(discountPct / 0.4, 0, 1)));
  return { score, discountPct, percentile };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
