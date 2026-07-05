import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import {
  activeDestinations,
  apiCallsToday,
  insertSnapshot,
  latestCaptureByRouteMonth,
  pruneSnapshots,
  recordApiCall,
  seedDestinations,
  snapshotsForRoute,
  snapshotsForRouteMonth,
} from '../db/repo.js';
import { DESTINATION_CATALOG } from '../scanner/destinations.js';

function snap(overrides: Partial<Parameters<typeof insertSnapshot>[1]> = {}) {
  return {
    origin: 'ABQ',
    destination: 'NAP',
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

    expect(snapshotsForRouteMonth(db, 'mock', 'ABQ', 'NAP', '2026-08', 60)).toHaveLength(1);
    expect(snapshotsForRoute(db, 'mock', 'ABQ', 'NAP', 90)).toHaveLength(2);
    const row = snapshotsForRouteMonth(db, 'mock', 'ABQ', 'NAP', '2026-08', 60)[0]!;
    expect(row.priceCents).toBe(75800);
    expect(row.capturedAt).toBeTruthy();
  });

  it('honors capturedAt overrides and an asOf window (simulator support)', () => {
    const db = openDb(':memory:');
    insertSnapshot(db, snap({ capturedAt: '2026-05-10 12:00:00', priceCents: 100000 }));
    insertSnapshot(db, snap({ capturedAt: '2026-06-20 12:00:00', priceCents: 90000 }));

    // As of July 1st, a 60-day window sees both; a 5-day window sees neither.
    expect(snapshotsForRouteMonth(db, 'mock', 'ABQ', 'NAP', '2026-08', 60, '2026-07-01 00:00:00')).toHaveLength(2);
    expect(snapshotsForRouteMonth(db, 'mock', 'ABQ', 'NAP', '2026-08', 5, '2026-07-01 00:00:00')).toHaveLength(0);
    // asOf excludes future captures
    expect(snapshotsForRoute(db, 'mock', 'ABQ', 'NAP', 60, '2026-05-11 00:00:00')).toHaveLength(1);
  });

  it('tracks latest capture per route-month for the planner', () => {
    const db = openDb(':memory:');
    insertSnapshot(db, snap({ capturedAt: '2026-07-01 08:00:00' }));
    insertSnapshot(db, snap({ capturedAt: '2026-07-03 08:00:00' }));
    insertSnapshot(db, snap({ destination: 'CUN', capturedAt: '2026-07-02 08:00:00' }));

    const latest = latestCaptureByRouteMonth(db, 'mock', 'ABQ');
    expect(latest.get('NAP|2026-08')).toBe('2026-07-03 08:00:00');
    expect(latest.get('CUN|2026-08')).toBe('2026-07-02 08:00:00');
  });

  it('prunes old snapshots', () => {
    const db = openDb(':memory:');
    insertSnapshot(db, snap({ capturedAt: '2020-01-01 00:00:00' }));
    insertSnapshot(db, snap());
    expect(pruneSnapshots(db, 180)).toBe(1);
    expect(snapshotsForRoute(db, 'mock', 'ABQ', 'NAP', 365)).toHaveLength(1);
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
    recordApiCall(db, { provider: 'travelpayouts', endpoint: 'prices_for_dates', ok: true });
    recordApiCall(db, { provider: 'travelpayouts', endpoint: 'prices_for_dates', ok: false, status: 429 });
    recordApiCall(db, { provider: 'other', endpoint: 'x', ok: true });
    expect(apiCallsToday(db, 'travelpayouts')).toBe(2);
  });
});
