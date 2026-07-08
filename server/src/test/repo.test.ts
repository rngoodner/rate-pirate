import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import {
  apiCallsToday,
  errorsToday,
  expireDealsOutsideUniverse,
  insertSnapshot,
  latestScanSnapshots,
  logEvent,
  pruneEvents,
  pruneSnapshots,
  recentEvents,
  recordApiCall,
  resetDailyBudget,
  upsertDeal,
} from '../db/repo.js';

function snap(overrides: Partial<Parameters<typeof insertSnapshot>[1]> = {}) {
  return {
    origin: 'ABQ',
    destination: 'NAP',
    city: 'Naples',
    country: 'Italy',
    cabin: 'economy' as const,
    tripType: 'one_week' as const,
    travelMonth: '2026-08',
    departDate: '2026-08-18',
    returnDate: '2026-08-26',
    priceCents: 75800,
    stops: 1,
    carrier: 'KL',
    source: 'mock',
    ...overrides,
  };
}

describe('repo', () => {
  it('returns the latest scan snapshots for a combo, cheapest first, with place info', () => {
    const db = openDb(':memory:');
    // Two captures of the same (destination, cabin, trip type) combo — only the
    // newest capture's rows come back.
    insertSnapshot(db, snap({ priceCents: 90000, capturedAt: '2026-06-19 12:00:00' }));
    insertSnapshot(db, snap({ priceCents: 80000, departDate: '2026-08-10', capturedAt: '2026-06-20 12:00:00' }));
    insertSnapshot(db, snap({ priceCents: 70000, departDate: '2026-08-18', capturedAt: '2026-06-20 12:00:00' }));
    // A different trip type must not bleed into the one-week query.
    insertSnapshot(db, snap({ tripType: 'weekend', priceCents: 40000, capturedAt: '2026-06-20 12:00:00' }));

    const rows = latestScanSnapshots(db, 'mock', 'ABQ', 'NAP', 'economy', 'one_week');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.priceCents).toBe(70000); // cheapest first
    expect(rows[0]!.city).toBe('Naples');
    expect(rows[0]!.country).toBe('Italy');
    // Isolated per trip type.
    expect(latestScanSnapshots(db, 'mock', 'ABQ', 'NAP', 'economy', 'weekend')[0]!.priceCents).toBe(
      40000,
    );
  });

  it('honors capturedAt overrides and an asOf window (simulator support)', () => {
    const db = openDb(':memory:');
    insertSnapshot(db, snap({ capturedAt: '2026-05-10 12:00:00', priceCents: 100000 }));
    insertSnapshot(db, snap({ capturedAt: '2026-06-20 12:00:00', priceCents: 90000 }));

    // As of mid-May only the earlier capture is visible.
    expect(
      latestScanSnapshots(db, 'mock', 'ABQ', 'NAP', 'economy', 'one_week', '2026-05-15 00:00:00')[0]!
        .priceCents,
    ).toBe(100000);
    // As of July the newer capture wins.
    expect(
      latestScanSnapshots(db, 'mock', 'ABQ', 'NAP', 'economy', 'one_week', '2026-07-01 00:00:00')[0]!
        .priceCents,
    ).toBe(90000);
  });

  it('prunes old snapshots', () => {
    const db = openDb(':memory:');
    insertSnapshot(db, snap({ capturedAt: '2020-01-01 00:00:00' }));
    insertSnapshot(db, snap({ capturedAt: '2026-06-20 12:00:00' }));
    expect(pruneSnapshots(db, 180)).toBe(1);
    expect(latestScanSnapshots(db, 'mock', 'ABQ', 'NAP', 'economy', 'one_week')).toHaveLength(1);
  });

  it('counts api calls made today', () => {
    const db = openDb(':memory:');
    recordApiCall(db, { provider: 'google-flights', endpoint: 'flights-page', ok: true });
    recordApiCall(db, { provider: 'google-flights', endpoint: 'flights-page', ok: false, status: 429 });
    recordApiCall(db, { provider: 'other', endpoint: 'x', ok: true });
    expect(apiCallsToday(db, 'google-flights')).toBe(2);
  });

  it('resets today\'s call budget for one provider only', () => {
    const db = openDb(':memory:');
    recordApiCall(db, { provider: 'google-flights', endpoint: 'flights-page', ok: true });
    recordApiCall(db, { provider: 'google-flights', endpoint: 'flights-page', ok: true });
    recordApiCall(db, { provider: 'other', endpoint: 'x', ok: true });
    const cleared = resetDailyBudget(db, 'google-flights');
    expect(cleared).toBe(2);
    expect(apiCallsToday(db, 'google-flights')).toBe(0);
    expect(apiCallsToday(db, 'other')).toBe(1); // other providers untouched
  });

  it('expires deals the scanner will never re-evaluate (origin, departed, cabin, trip type)', () => {
    const db = openDb(':memory:');
    const base = {
      source: 'mock',
      origin: 'ABQ',
      destination: 'NAP',
      city: 'Naples',
      country: 'Italy',
      cabin: 'economy' as const,
      tripType: 'one_week' as const,
      travelMonth: '2026-09',
      bestPriceCents: 65000,
      baselinePriceCents: 100000,
      discountPct: 0.35,
      score: 93,
      departDate: '2026-09-12',
      returnDate: '2026-09-19',
      seenAt: '2026-07-06 08:00:00',
    };
    const keep = upsertDeal(db, base);
    const wrongOrigin = upsertDeal(db, { ...base, origin: 'DEN', destination: 'CUN' });
    // Cabins/trip types the user no longer monitors ARE swept (feed hides them,
    // but the scanner never touches them again so they'd show stale prices).
    const otherCabin = upsertDeal(db, { ...base, cabin: 'first', destination: 'LIS' });
    const otherTrip = upsertDeal(db, { ...base, tripType: 'weekend', destination: 'OSL' });
    const departed = upsertDeal(db, {
      ...base,
      destination: 'SEA',
      departDate: '2026-07-04',
      returnDate: '2026-07-11',
    });

    const expired = expireDealsOutsideUniverse(db, {
      source: 'mock',
      origin: 'ABQ',
      today: '2026-07-06',
      cabins: ['economy'],
      tripTypes: ['one_week'],
    });
    expect(expired).toBe(4);
    const status = (id: number) =>
      (db.prepare('SELECT status FROM deals WHERE id = ?').get(id) as { status: string }).status;
    expect(status(keep.id)).toBe('active');
    for (const d of [wrongOrigin, otherCabin, otherTrip, departed]) {
      expect(status(d.id)).toBe('expired');
    }
  });

  it('logs, lists, counts, and prunes app events', () => {
    const db = openDb(':memory:');
    logEvent(db, { level: 'info', scope: 'batch', message: 'batch: 25/25 scanned' });
    logEvent(db, { level: 'error', scope: 'scan', message: 'ABQ→NAP failed', detail: 'stack…' });
    // Old event, beyond the prune window and not "today".
    logEvent(db, {
      level: 'error',
      scope: 'scan',
      message: 'ancient failure',
      at: '2026-01-01 12:00:00',
    });

    const events = recentEvents(db, 10);
    expect(events).toHaveLength(3);
    expect(events[0]!.message).toContain('ABQ→NAP'); // newest first (same-second: by id)
    expect(events[0]!.detail).toBe('stack…');
    expect(errorsToday(db)).toBe(1); // the ancient error is not today
    expect(pruneEvents(db, 30)).toBe(1);
    expect(recentEvents(db, 10)).toHaveLength(2);
  });

  it('uses the LOCAL day boundary, not UTC midnight', () => {
    const db = openDb(':memory:');
    // A call made 1 minute ago is always "today" local, even when UTC has
    // already rolled over to the next date (evenings in UTC-negative zones).
    db.prepare(
      `INSERT INTO api_calls (provider, endpoint, ok, called_at)
       VALUES ('google-flights', 'flights-page', 1, datetime('now', '-1 minute'))`,
    ).run();
    // A call just before local midnight is "yesterday" and must not count.
    db.prepare(
      `INSERT INTO api_calls (provider, endpoint, ok, called_at)
       VALUES ('google-flights', 'flights-page', 1,
               datetime(date('now', 'localtime'), 'utc', '-1 minute'))`,
    ).run();
    expect(apiCallsToday(db, 'google-flights')).toBe(1);
  });
});
