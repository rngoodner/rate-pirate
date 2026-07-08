import { describe, expect, it } from 'vitest';
import { computeBaseline, median } from '../deals/baseline.js';
import { scoreDeal } from '../deals/score.js';
import { processCandidate, reevaluateDeals, type Candidate } from '../deals/detect.js';
import { openDb } from '../db/db.js';
import { getDealByCombo, insertSnapshot, upsertDeal, upsertPriceInsights } from '../db/repo.js';

describe('median', () => {
  it('handles odd, even, and single-element inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(3); // rounded mean of 2,3 -> 3 (Math.round(2.5))
    expect(median([7])).toBe(7);
  });
});

describe('computeBaseline', () => {
  const insights = (medianCents: number | null) => ({
    level: 'typical' as const,
    medianCents,
    series: medianCents == null ? [] : [{ date: '2026-06-01', priceCents: medianCents }],
    capturedAt: '2026-07-06 08:00:00',
  });

  it('returns null without Google insights or a median', () => {
    expect(computeBaseline()).toBeNull();
    expect(computeBaseline(null)).toBeNull();
    // Insights without a median (no history captured yet) can't be a baseline.
    expect(computeBaseline(insights(null))).toBeNull();
  });

  it('uses the Google-history median as the baseline', () => {
    expect(computeBaseline(insights(92000))).toEqual({ baselineCents: 92000, kind: 'google' });
  });
});

describe('scoreDeal googleLevel corroboration', () => {
  const base = { currentCents: 80000, baselineCents: 100000, routeHistoryCents: [90000, 95000, 100000, 105000] };

  it('nudges the score by Google’s verdict without dominating it', () => {
    const neutral = scoreDeal(base).score;
    expect(scoreDeal({ ...base, googleLevel: 'low' }).score).toBe(neutral + 8);
    expect(scoreDeal({ ...base, googleLevel: 'typical' }).score).toBe(neutral);
    expect(scoreDeal({ ...base, googleLevel: 'high' }).score).toBe(neutral - 8);
    expect(scoreDeal({ ...base, googleLevel: null }).score).toBe(neutral);
  });

  it('clamps at the 0–100 bounds', () => {
    const max = { currentCents: 50000, baselineCents: 100000, routeHistoryCents: [90000, 100000] };
    expect(scoreDeal({ ...max, googleLevel: 'low' }).score).toBe(100);
    const min = { currentCents: 120000, baselineCents: 100000, routeHistoryCents: [90000, 100000] };
    expect(scoreDeal({ ...min, googleLevel: 'high' }).score).toBe(0);
  });
});

describe('scoreDeal', () => {
  it('scores ~100 for a deep discount undercutting all history', () => {
    const { score } = scoreDeal({
      currentCents: 60000,
      baselineCents: 100000,
      routeHistoryCents: Array(50).fill(100000),
    });
    expect(score).toBe(100);
  });

  it('scores ~50 at the median price', () => {
    const history = [90000, 95000, 100000, 105000, 110000];
    const { score } = scoreDeal({
      currentCents: 100000,
      baselineCents: 100000,
      routeHistoryCents: history,
    });
    expect(score).toBeGreaterThanOrEqual(20);
    expect(score).toBeLessThanOrEqual(50);
  });

  it('caps the discount contribution at 40% below baseline', () => {
    const a = scoreDeal({ currentCents: 60000, baselineCents: 100000, routeHistoryCents: [] });
    const b = scoreDeal({ currentCents: 30000, baselineCents: 100000, routeHistoryCents: [] });
    expect(a.score).toBe(40);
    expect(b.score).toBe(40); // percentile 0 with empty history; discount term maxed
  });

  it('reports negative discount above baseline', () => {
    const { discountPct } = scoreDeal({
      currentCents: 120000,
      baselineCents: 100000,
      routeHistoryCents: [],
    });
    expect(discountPct).toBeCloseTo(-0.2);
  });
});

describe('processCandidate', () => {
  const cand: Candidate = {
    source: 'mock',
    origin: 'ABQ',
    destination: 'NAP',
    city: 'Naples',
    country: 'Italy',
    cabin: 'economy',
    tripType: 'one_week',
  };
  const key = { source: 'mock', origin: 'ABQ', destination: 'NAP', cabin: 'economy' as const, tripType: 'one_week' as const };

  function insertCurrent(db: ReturnType<typeof openDb>, priceCents: number, capturedAt: string) {
    insertSnapshot(db, {
      origin: 'ABQ',
      destination: 'NAP',
      city: 'Naples',
      country: 'Italy',
      cabin: 'economy',
      tripType: 'one_week',
      travelMonth: '2026-08',
      departDate: '2026-08-10',
      returnDate: '2026-08-17',
      priceCents,
      stops: 1,
      carrier: 'AA',
      source: 'mock',
      capturedAt,
    });
  }

  /** Google baseline via insights median. */
  function seedBaseline(db: ReturnType<typeof openDb>, medianCents: number, capturedAt: string) {
    upsertPriceInsights(db, key, {
      level: 'low',
      history: [{ date: '2026-06-01', priceCents: medianCents }],
      capturedAt,
    });
  }

  it('ignores a stale Google verdict (different scan) but applies a same-scan one', () => {
    const db = openDb(':memory:');
    // A modest discount so the base score leaves headroom for the +8 nudge
    // (a deep discount would already clamp at 100 and hide it).
    insertCurrent(db, 80000, '2026-06-20 08:00:00');

    // Insight captured in a DIFFERENT (earlier) scan → verdict must be ignored.
    seedBaseline(db, 100000, '2026-06-01 08:00:00');
    const stale = processCandidate(db, cand, '2026-06-20 08:00:00')!;

    // Same insight, now stamped to THIS scan → +8 nudge applies.
    seedBaseline(db, 100000, '2026-06-20 08:00:00');
    const fresh = processCandidate(db, cand, '2026-06-20 08:00:00')!;
    expect(fresh.score).toBe(stale.score + 8);
  });

  it('creates a deal when the latest price is well below the Google baseline', () => {
    const db = openDb(':memory:');
    insertCurrent(db, 65000, '2026-06-20 08:00:00');
    seedBaseline(db, 100000, '2026-06-19 08:00:00');

    const deal = processCandidate(db, cand, '2026-06-20 08:00:00');
    expect(deal).not.toBeNull();
    expect(deal!.bestPriceCents).toBe(65000);
    expect(deal!.baselinePriceCents).toBe(100000);
    expect(deal!.discountPct).toBeCloseTo(0.35);
    expect(deal!.status).toBe('active');
    expect(deal!.departDate).toBe('2026-08-10');
    expect(deal!.baselineSource).toBe('google');

    // A custom feed floor above the discount suppresses (and expires) the deal.
    const suppressed = processCandidate(db, cand, '2026-06-20 09:00:00', { minDiscount: 0.4 });
    expect(suppressed).toBeNull();
    expect(getDealByCombo(db, 'mock', 'ABQ', 'NAP', 'economy', 'one_week')!.status).toBe('expired');

    // reevaluateDeals sweeps the whole feed from stored snapshots — lowering
    // the floor resurrects the deal instantly, no new scan required.
    const win = { currentMonth: '2026-06', today: '2026-06-20', cabins: ['economy' as const], tripTypes: ['one_week' as const] };
    reevaluateDeals(db, 'mock', 'ABQ', 0.05, win, '2026-06-20 10:00:00');
    expect(getDealByCombo(db, 'mock', 'ABQ', 'NAP', 'economy', 'one_week')!.status).toBe('active');
    reevaluateDeals(db, 'mock', 'ABQ', 0.4, win, '2026-06-20 11:00:00');
    expect(getDealByCombo(db, 'mock', 'ABQ', 'NAP', 'economy', 'one_week')!.status).toBe('expired');

    // A past-travel-month deal must be EXPIRED by a re-evaluate, never revived.
    upsertDeal(db, {
      source: 'mock', origin: 'ABQ', destination: 'CUN', city: 'Cancún', country: 'Mexico',
      cabin: 'economy', tripType: 'one_week', travelMonth: '2026-05',
      bestPriceCents: 60000, baselinePriceCents: 100000, discountPct: 0.4, score: 95,
      departDate: '2026-05-10', returnDate: '2026-05-17', seenAt: '2026-05-15 12:00:00',
    });
    reevaluateDeals(db, 'mock', 'ABQ', 0.05, win, '2026-06-20 12:00:00');
    expect(getDealByCombo(db, 'mock', 'ABQ', 'CUN', 'economy', 'one_week')!.status).toBe('expired');
  });

  it('returns null during cold start (no Google baseline yet) and creates no deal', () => {
    const db = openDb(':memory:');
    insertCurrent(db, 65000, '2026-06-20 08:00:00'); // a price, but no insights baseline
    expect(processCandidate(db, cand, '2026-06-20 08:00:00')).toBeNull();
    expect(getDealByCombo(db, 'mock', 'ABQ', 'NAP', 'economy', 'one_week')).toBeNull();
  });

  it('expires the deal when the price recovers', () => {
    const db = openDb(':memory:');
    seedBaseline(db, 100000, '2026-06-19 08:00:00');
    insertCurrent(db, 65000, '2026-06-20 08:00:00');
    processCandidate(db, cand, '2026-06-20 08:00:00');

    // Next scan: price back to normal.
    insertCurrent(db, 99000, '2026-06-21 08:00:00');
    expect(processCandidate(db, cand, '2026-06-21 08:00:00')).toBeNull();
    expect(getDealByCombo(db, 'mock', 'ABQ', 'NAP', 'economy', 'one_week')!.status).toBe('expired');
  });

  it('refreshes an existing deal in place (same combo stays one row)', () => {
    const db = openDb(':memory:');
    seedBaseline(db, 100000, '2026-06-19 08:00:00');
    for (const [day, price] of [
      ['20', 70000],
      ['21', 62000],
    ] as const) {
      insertCurrent(db, price, `2026-06-${day} 08:00:00`);
      processCandidate(db, cand, `2026-06-${day} 08:00:00`);
    }
    const deal = getDealByCombo(db, 'mock', 'ABQ', 'NAP', 'economy', 'one_week')!;
    expect(deal.bestPriceCents).toBe(62000);
    expect(deal.firstSeenAt).toBe('2026-06-20 08:00:00');
    expect(deal.lastSeenAt).toBe('2026-06-21 08:00:00');
  });
});
