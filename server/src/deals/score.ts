export interface ScoreInput {
  currentCents: number;
  baselineCents: number;
  /** Route-wide price history (all months) over the last 90 days. */
  routeHistoryCents: number[];
  /** Google's own price verdict from the scan page, when captured. */
  googleLevel?: 'low' | 'typical' | 'high' | null;
}

export interface ScoreResult {
  /** 0–100. */
  score: number;
  /** 0..1 fraction below baseline (negative = above baseline). */
  discountPct: number;
  /** 0..1 fraction of history strictly more expensive than the current price. */
  percentile: number;
}

/** Corroboration nudge from Google's verdict: computed from far deeper history
 *  than ours, it's genuinely independent signal — enough to tip a borderline
 *  deal across (or away from) the alert threshold, never enough to manufacture
 *  a deal on its own. */
const LEVEL_ADJUSTMENT = { low: 8, typical: 0, high: -8 } as const;

/** A price 40% below baseline that undercuts all recent history scores ~100;
 *  a price at the median scores ~50. */
export function scoreDeal(input: ScoreInput): ScoreResult {
  const { currentCents, baselineCents, routeHistoryCents } = input;
  const percentile =
    routeHistoryCents.length === 0
      ? 0
      : routeHistoryCents.filter((p) => p > currentCents).length / routeHistoryCents.length;
  const discountPct = (baselineCents - currentCents) / baselineCents;
  const base = Math.round(100 * (0.6 * percentile + 0.4 * clamp(discountPct / 0.4, 0, 1)));
  const score = clamp(base + (input.googleLevel ? LEVEL_ADJUSTMENT[input.googleLevel] : 0), 0, 100);
  return { score, discountPct, percentile };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
