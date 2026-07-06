import { describe, expect, it } from 'vitest';
import { horizonMonths, planBatch } from '../scanner/planner.js';
import { nextBatchAt } from '../scanner/scheduler.js';
import type { DestinationRow } from '../db/repo.js';

describe('nextBatchAt', () => {
  it('finds the next 06:10/11:10/17:10/22:10 America/Denver slot in UTC', () => {
    // 07:00 MDT (13:00Z) → next is 11:10 MDT = 17:10Z same day
    expect(nextBatchAt(new Date('2026-07-06T13:00:00Z')).toISOString()).toBe(
      '2026-07-06T17:10:00.000Z',
    );
    // 23:00 MDT Jul 6 (05:00Z Jul 7) → next is 06:10 MDT Jul 7 = 12:10Z
    expect(nextBatchAt(new Date('2026-07-07T05:00:00Z')).toISOString()).toBe(
      '2026-07-07T12:10:00.000Z',
    );
    // Exactly 06:10 MDT → that slot has fired; next is 11:10 MDT
    expect(nextBatchAt(new Date('2026-07-06T12:10:00Z')).toISOString()).toBe(
      '2026-07-06T17:10:00.000Z',
    );
    // Winter (MST, UTC-7): 23:30 MST Dec 31 (06:30Z Jan 1) → 06:10 MST Jan 1 = 13:10Z
    expect(nextBatchAt(new Date('2027-01-01T06:30:00Z')).toISOString()).toBe(
      '2027-01-01T13:10:00.000Z',
    );
    // Month-end rollover: 22:30 MDT Jul 31 → 06:10 MDT Aug 1
    expect(nextBatchAt(new Date('2026-08-01T04:30:00Z')).toISOString()).toBe(
      '2026-08-01T12:10:00.000Z',
    );
  });
});

const now = new Date('2026-07-05T12:00:00Z');

function dest(iata: string, tier: number): DestinationRow {
  return { iata, city: iata, country: 'X', region: 'europe', tier, active: true };
}

describe('horizonMonths', () => {
  it('returns +1..+N months, crossing year boundaries', () => {
    expect(horizonMonths(now, 6)).toEqual([
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
    ]);
  });
});

describe('planBatch', () => {
  it('covers the whole universe when the limit allows', () => {
    const tasks = planBatch({
      cabins: ['economy'],
      destinations: [dest('AAA', 1), dest('BBB', 2)],
      latestCapture: new Map(),
      now,
      horizon: 6,
      limit: 100,
    });
    expect(tasks).toHaveLength(12);
  });

  it('prefers tier 1 and near months among never-scanned routes', () => {
    const tasks = planBatch({
      cabins: ['economy'],
      destinations: [dest('TTT', 3), dest('ONE', 1), dest('TWO', 2)],
      latestCapture: new Map(),
      now,
      horizon: 6,
      limit: 6,
    });
    // Tier 1 near months first (staleness ties, weight 3 × boost 1.5 dominates)
    expect(tasks.slice(0, 3).every((t) => t.destination === 'ONE')).toBe(true);
    expect(tasks[0]!.month).toBe('2026-08');
    expect(tasks.map((t) => t.destination)).not.toContain('TTT');
  });

  it('prefers staler route-months within a tier', () => {
    const tasks = planBatch({
      cabins: ['economy'],
      destinations: [dest('AAA', 2), dest('BBB', 2)],
      latestCapture: new Map([
        ['AAA|2026-08|economy', '2026-07-05 06:00:00'], // scanned 6h ago
        ['BBB|2026-08|economy', '2026-07-01 06:00:00'], // scanned 4 days ago
      ]),
      now,
      horizon: 1,
      limit: 1,
    });
    expect(tasks[0]!.destination).toBe('BBB');
  });

  it('never-scanned outranks recently-scanned regardless of tier', () => {
    const tasks = planBatch({
      cabins: ['economy'],
      destinations: [dest('FAV', 1), dest('NEW', 3)],
      latestCapture: new Map([['FAV|2026-08|economy', '2026-07-05 11:00:00']]),
      now,
      horizon: 1,
      limit: 1,
    });
    expect(tasks[0]!.destination).toBe('NEW');
  });

  it('respects the limit and returns nothing for a spent budget', () => {
    const tasks = planBatch({
      cabins: ['economy'],
      destinations: [dest('AAA', 1)],
      latestCapture: new Map(),
      now,
      horizon: 6,
      limit: 2,
    });
    expect(tasks).toHaveLength(2);
    expect(
      planBatch({ cabins: ['economy'], destinations: [dest('AAA', 1)], latestCapture: new Map(), now, horizon: 6, limit: 0 }),
    ).toHaveLength(0);
  });
});
