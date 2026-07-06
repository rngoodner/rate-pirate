import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import {
  activeDestinations,
  apiCallsToday,
  errorsToday,
  expireDealsOutsideUniverse,
  insertSnapshot,
  latestCaptureByRouteMonth,
  logEvent,
  pruneEvents,
  pruneSnapshots,
  recentEvents,
  recordApiCall,
  seedDestinations,
  snapshotsForRoute,
  snapshotsForRouteMonth,
  upsertDeal,
} from '../db/repo.js';
import { DESTINATION_CATALOG } from '../scanner/destinations.js';

function snap(overrides: Partial<Parameters<typeof insertSnapshot>[1]> = {}) {
  return {
    origin: 'ABQ',
    destination: 'NAP',
    cabin: 'economy' as const,
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
  it('inserts and queries snapshots by route-month and route', () => {
    const db = openDb(':memory:');
    insertSnapshot(db, snap());
    insertSnapshot(db, snap({ travelMonth: '2026-09', departDate: '2026-09-05' }));
    insertSnapshot(db, snap({ destination: 'CUN' }));

    expect(snapshotsForRouteMonth(db, 'mock', 'ABQ', 'NAP', 'economy', '2026-08', 60)).toHaveLength(1);
    expect(snapshotsForRoute(db, 'mock', 'ABQ', 'NAP', 'economy', 90)).toHaveLength(2);
    const row = snapshotsForRouteMonth(db, 'mock', 'ABQ', 'NAP', 'economy', '2026-08', 60)[0]!;
    expect(row.priceCents).toBe(75800);
    expect(row.capturedAt).toBeTruthy();
  });

  it('honors capturedAt overrides and an asOf window (simulator support)', () => {
    const db = openDb(':memory:');
    insertSnapshot(db, snap({ capturedAt: '2026-05-10 12:00:00', priceCents: 100000 }));
    insertSnapshot(db, snap({ capturedAt: '2026-06-20 12:00:00', priceCents: 90000 }));

    // As of July 1st, a 60-day window sees both; a 5-day window sees neither.
    expect(snapshotsForRouteMonth(db, 'mock', 'ABQ', 'NAP', 'economy', '2026-08', 60, '2026-07-01 00:00:00')).toHaveLength(2);
    expect(snapshotsForRouteMonth(db, 'mock', 'ABQ', 'NAP', 'economy', '2026-08', 5, '2026-07-01 00:00:00')).toHaveLength(0);
    // asOf excludes future captures
    expect(snapshotsForRoute(db, 'mock', 'ABQ', 'NAP', 'economy', 60, '2026-05-11 00:00:00')).toHaveLength(1);
  });

  it('tracks latest capture per route-month for the planner', () => {
    const db = openDb(':memory:');
    insertSnapshot(db, snap({ capturedAt: '2026-07-01 08:00:00' }));
    insertSnapshot(db, snap({ capturedAt: '2026-07-03 08:00:00' }));
    insertSnapshot(db, snap({ destination: 'CUN', capturedAt: '2026-07-02 08:00:00' }));

    const latest = latestCaptureByRouteMonth(db, 'mock', 'ABQ');
    expect(latest.get('NAP|2026-08|economy')).toBe('2026-07-03 08:00:00');
    expect(latest.get('CUN|2026-08|economy')).toBe('2026-07-02 08:00:00');
  });

  it('prunes old snapshots', () => {
    const db = openDb(':memory:');
    insertSnapshot(db, snap({ capturedAt: '2020-01-01 00:00:00' }));
    insertSnapshot(db, snap());
    expect(pruneSnapshots(db, 180)).toBe(1);
    expect(snapshotsForRoute(db, 'mock', 'ABQ', 'NAP', 'economy', 365)).toHaveLength(1);
  });

  it('seeds the destination catalog idempotently', () => {
    const db = openDb(':memory:');
    seedDestinations(db, DESTINATION_CATALOG);
    seedDestinations(db, DESTINATION_CATALOG);
    const active = activeDestinations(db);
    expect(active.length).toBe(DESTINATION_CATALOG.length);
    expect(active.find((d) => d.iata === 'NAP')).toMatchObject({
      city: 'Naples',
      country: 'Italy',
      tier: 2,
      active: true,
    });
  });

  it('counts api calls made today', () => {
    const db = openDb(':memory:');
    recordApiCall(db, { provider: 'google-flights', endpoint: 'flights-page', ok: true });
    recordApiCall(db, { provider: 'google-flights', endpoint: 'flights-page', ok: false, status: 429 });
    recordApiCall(db, { provider: 'other', endpoint: 'x', ok: true });
    expect(apiCallsToday(db, 'google-flights')).toBe(2);
  });

  it('expires zombie deals outside the scanned universe', () => {
    const db = openDb(':memory:');
    const base = {
      source: 'mock',
      origin: 'ABQ',
      destination: 'NAP',
      cabin: 'economy' as const,
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
    // Unmonitored cabins are deliberately NOT expired (feed hides them instead).
    const otherCabin = upsertDeal(db, { ...base, cabin: 'first', destination: 'LIS' });
    const wrongOrigin = upsertDeal(db, { ...base, origin: 'DEN', destination: 'CUN' });
    const beyondHorizon = upsertDeal(db, { ...base, travelMonth: '2027-05', destination: 'OSL', departDate: '2027-05-09', returnDate: '2027-05-16' });
    const departed = upsertDeal(db, { ...base, travelMonth: '2026-07', destination: 'SEA', departDate: '2026-07-04', returnDate: '2026-07-11' });

    const expired = expireDealsOutsideUniverse(db, {
      source: 'mock',
      origin: 'ABQ',
      lastMonth: '2027-01',
      today: '2026-07-06',
    });
    expect(expired).toBe(3);
    const status = (id: number) =>
      (db.prepare('SELECT status FROM deals WHERE id = ?').get(id) as { status: string }).status;
    expect(status(keep.id)).toBe('active');
    expect(status(otherCabin.id)).toBe('active');
    for (const d of [wrongOrigin, beyondHorizon, departed]) {
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
