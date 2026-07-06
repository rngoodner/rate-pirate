import { describe, expect, it } from 'vitest';
import { computeBaseline, median } from '../deals/baseline.js';
import { scoreDeal } from '../deals/score.js';
import { processRouteMonth } from '../deals/detect.js';
import { openDb } from '../db/db.js';
import { getDealByRouteMonth, insertSnapshot, type SnapshotRow } from '../db/repo.js';

function rows(prices: number[], startDay = 1, month = '2026-06'): SnapshotRow[] {
  return prices.map((priceCents, i) => ({
    id: i,
    origin: 'ABQ',
    destination: 'NAP',
    cabin: 'economy' as const,
    travelMonth: '2026-08',
    departDate: '2026-08-18',
    returnDate: '2026-08-26',
    priceCents,
    stops: 1,
    carrier: 'KL',
    source: 'mock',
    capturedAt: `${month}-${String(startDay + i).padStart(2, '0')} 12:00:00`,
  }));
}

describe('median', () => {
  it('handles odd, even, and single-element inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(3); // rounded mean of 2,3 -> 3 (Math.round(2.5))
    expect(median([7])).toBe(7);
  });
});

describe('computeBaseline', () => {
  it('cold start: not enough data returns null', () => {
    expect(computeBaseline([], [])).toBeNull();
    expect(computeBaseline(rows([100, 100, 100]), rows([100, 100, 100]))).toBeNull();
  });

  it('uses the month median when the month history is deep enough', () => {
    const month = rows([100000, 101000, 99000, 102000, 98000, 100500, 99500, 100200, 101500, 98500]);
    const route = rows(Array(20).fill(50000));
    expect(computeBaseline(month, route)).toEqual({ baselineCents: 100100, kind: 'month' });
  });

  it('falls back to the route median when only the route is deep enough', () => {
    const month = rows([100000, 101000]); // too shallow
    const route = rows(Array(15).fill(80000), 1);
    expect(computeBaseline(month, route)).toEqual({ baselineCents: 80000, kind: 'route' });
  });

  it('requires distinct days, not just row count', () => {
    const sameDay = rows(Array(12).fill(100000)).map((r) => ({
      ...r,
      capturedAt: '2026-06-01 12:00:00',
    }));
    expect(computeBaseline(sameDay, sameDay)).toBeNull();
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

describe('processRouteMonth', () => {
  const route = { source: 'mock', origin: 'ABQ', destination: 'NAP', cabin: 'economy' as const, month: '2026-08' };

  function seedHistory(db: ReturnType<typeof openDb>, priceCents: number, days = 12) {
    for (let day = 1; day <= days; day++) {
      insertSnapshot(db, {
        origin: 'ABQ',
        destination: 'NAP',
        cabin: 'economy',
        travelMonth: '2026-08',
        departDate: '2026-08-18',
        returnDate: '2026-08-26',
        priceCents,
        stops: 1,
        carrier: 'KL',
        source: 'mock',
        capturedAt: `2026-06-${String(day).padStart(2, '0')} 12:00:00`,
      });
    }
  }

  it('creates a deal when the latest price is well below baseline', () => {
    const db = openDb(':memory:');
    seedHistory(db, 100000);
    insertSnapshot(db, {
      origin: 'ABQ',
      destination: 'NAP',
      cabin: 'economy',
      travelMonth: '2026-08',
      departDate: '2026-08-10',
      returnDate: '2026-08-17',
      priceCents: 65000,
      stops: 1,
      carrier: 'AA',
      source: 'mock',
      capturedAt: '2026-06-20 08:00:00',
    });

    const deal = processRouteMonth(db, route, '2026-06-20 08:00:00');
    expect(deal).not.toBeNull();
    expect(deal!.bestPriceCents).toBe(65000);
    expect(deal!.baselinePriceCents).toBe(100000);
    expect(deal!.discountPct).toBeCloseTo(0.35);
    expect(deal!.status).toBe('active');
    expect(deal!.departDate).toBe('2026-08-10');
  });

  it('returns null during cold start and creates no deal', () => {
    const db = openDb(':memory:');
    seedHistory(db, 100000, 3); // too few days
    expect(processRouteMonth(db, route, '2026-06-04 12:00:00')).toBeNull();
    expect(getDealByRouteMonth(db, 'mock', 'ABQ', 'NAP', 'economy', '2026-08')).toBeNull();
  });

  it('expires the deal when the price recovers', () => {
    const db = openDb(':memory:');
    seedHistory(db, 100000);
    insertSnapshot(db, {
      origin: 'ABQ',
      destination: 'NAP',
      cabin: 'economy',
      travelMonth: '2026-08',
      departDate: '2026-08-10',
      returnDate: '2026-08-17',
      priceCents: 65000,
      stops: 1,
      carrier: 'AA',
      source: 'mock',
      capturedAt: '2026-06-20 08:00:00',
    });
    processRouteMonth(db, route, '2026-06-20 08:00:00');

    // Next scan: price back to normal
    insertSnapshot(db, {
      origin: 'ABQ',
      destination: 'NAP',
      cabin: 'economy',
      travelMonth: '2026-08',
      departDate: '2026-08-18',
      returnDate: '2026-08-26',
      priceCents: 99000,
      stops: 1,
      carrier: 'KL',
      source: 'mock',
      capturedAt: '2026-06-21 08:00:00',
    });
    expect(processRouteMonth(db, route, '2026-06-21 08:00:00')).toBeNull();
    expect(getDealByRouteMonth(db, 'mock', 'ABQ', 'NAP', 'economy', '2026-08')!.status).toBe('expired');
  });

  it('refreshes an existing deal in place (same route-month stays one row)', () => {
    const db = openDb(':memory:');
    seedHistory(db, 100000);
    for (const [day, price] of [
      [20, 70000],
      [21, 62000],
    ] as const) {
      insertSnapshot(db, {
        origin: 'ABQ',
        destination: 'NAP',
        cabin: 'economy',
        travelMonth: '2026-08',
        departDate: '2026-08-10',
        returnDate: '2026-08-17',
        priceCents: price,
        stops: 1,
        carrier: 'AA',
        source: 'mock',
        capturedAt: `2026-06-${day} 08:00:00`,
      });
      processRouteMonth(db, route, `2026-06-${day} 08:00:00`);
    }
    const deal = getDealByRouteMonth(db, 'mock', 'ABQ', 'NAP', 'economy', '2026-08')!;
    expect(deal.bestPriceCents).toBe(62000);
    expect(deal.firstSeenAt).toBe('2026-06-20 08:00:00');
    expect(deal.lastSeenAt).toBe('2026-06-21 08:00:00');
  });
});
