import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import {
  activeDealsWithPlace,
  combosWithBaseline,
  insertSnapshot,
  latestScanSnapshots,
  upsertPriceInsights,
} from '../db/repo.js';
import { getSettings, updateSettings } from '../db/settings.js';
import { loadConfig } from '../config.js';
import { processCandidate } from '../deals/detect.js';
import { SyntheticProvider } from '../providers/mock.js';
import { runScanBatch } from '../scanner/scan.js';
import type { Cabin, TripType } from '@rate-pirate/shared';

const config = loadConfig({});

/** Seed a fresh scan snapshot for a cabin plus the Google baseline (insights
 *  median) it is scored against. */
function seedCombo(
  db: ReturnType<typeof openDb>,
  cabin: Cabin,
  currentCents: number,
  baselineCents: number,
) {
  upsertPriceInsights(
    db,
    { source: 'mock', origin: 'ABQ', destination: 'NAP', cabin, tripType: 'one_week' },
    {
      level: 'typical',
      history: [{ date: '2026-06-01', priceCents: baselineCents }],
      capturedAt: '2026-06-19 12:00:00',
    },
  );
  insertSnapshot(db, {
    origin: 'ABQ',
    destination: 'NAP',
    city: 'Naples',
    country: 'Italy',
    cabin,
    tripType: 'one_week',
    travelMonth: '2026-08',
    departDate: '2026-08-10',
    returnDate: '2026-08-17',
    priceCents: currentCents,
    stops: 1,
    carrier: 'AA',
    source: 'mock',
    capturedAt: '2026-06-20 08:00:00',
  });
}

describe('cabin isolation', () => {
  it('keeps snapshots separate per cabin', () => {
    const db = openDb(':memory:');
    seedCombo(db, 'economy', 62000, 100000);
    seedCombo(db, 'business', 250000, 400000);

    expect(latestScanSnapshots(db, 'mock', 'ABQ', 'NAP', 'economy', 'one_week')[0]!.priceCents).toBe(
      62000,
    );
    expect(
      latestScanSnapshots(db, 'mock', 'ABQ', 'NAP', 'business', 'one_week')[0]!.priceCents,
    ).toBe(250000);
  });

  it('detects an independent deal in each cabin', () => {
    const db = openDb(':memory:');
    seedCombo(db, 'economy', 62000, 100000);
    seedCombo(db, 'business', 250000, 400000);
    const cand = (cabin: Cabin) => ({
      source: 'mock',
      origin: 'ABQ',
      destination: 'NAP',
      city: 'Naples',
      country: 'Italy',
      cabin,
      tripType: 'one_week' as const,
    });

    const econ = processCandidate(db, cand('economy'), '2026-06-20 08:00:00');
    const biz = processCandidate(db, cand('business'), '2026-06-20 08:00:00');
    expect(econ?.cabin).toBe('economy');
    expect(econ?.bestPriceCents).toBe(62000);
    expect(econ?.baselinePriceCents).toBe(100000);
    expect(biz?.cabin).toBe('business');
    expect(biz?.bestPriceCents).toBe(250000);
    expect(biz?.baselinePriceCents).toBe(400000);

    // The feed only shows monitored cabins.
    expect(activeDealsWithPlace(db, 'mock', ['economy'], ['weekend', 'one_week', 'two_weeks']).map((d) => d.cabin)).toEqual(['economy']);
    expect(
      activeDealsWithPlace(db, 'mock', ['economy', 'business'], ['weekend', 'one_week', 'two_weeks']).map((d) => d.cabin).sort(),
    ).toEqual(['business', 'economy']);
    expect(activeDealsWithPlace(db, 'mock', [], ['weekend', 'one_week', 'two_weeks'])).toHaveLength(0);
  });

  it('counts distinct (cabin, trip type) combos with a Google baseline', () => {
    const db = openDb(':memory:');
    seedCombo(db, 'economy', 62000, 100000);
    seedCombo(db, 'business', 250000, 400000);
    expect(combosWithBaseline(db, 'mock', 'ABQ', ['economy', 'business'], ['weekend', 'one_week', 'two_weeks'])).toBe(2);
  });
});

/** Seed a fresh scan snapshot + Google baseline for a (trip type) combo on a
 *  fixed destination/cabin, so trip types can be scored independently. */
function seedTripCombo(
  db: ReturnType<typeof openDb>,
  tripType: TripType,
  currentCents: number,
  baselineCents: number,
  departDate: string,
) {
  upsertPriceInsights(
    db,
    { source: 'mock', origin: 'ABQ', destination: 'NAP', cabin: 'economy', tripType },
    { level: 'typical', history: [{ date: '2026-06-01', priceCents: baselineCents }], capturedAt: '2026-06-19 12:00:00' },
  );
  insertSnapshot(db, {
    origin: 'ABQ',
    destination: 'NAP',
    city: 'Naples',
    country: 'Italy',
    cabin: 'economy',
    tripType,
    travelMonth: departDate.slice(0, 7),
    departDate,
    returnDate: departDate,
    priceCents: currentCents,
    stops: 1,
    carrier: 'AA',
    source: 'mock',
    capturedAt: '2026-06-20 08:00:00',
  });
}

describe('trip-type isolation', () => {
  it('keeps weekend and 1-week as two independent deals on the same route/cabin', () => {
    const db = openDb(':memory:');
    // Same destination + cabin, different trip shapes → distinct deal rows keyed
    // by (source, origin, destination, cabin, trip_type).
    seedTripCombo(db, 'weekend', 55000, 90000, '2026-08-08');
    seedTripCombo(db, 'one_week', 62000, 100000, '2026-08-10');
    const cand = (tripType: TripType) => ({
      source: 'mock',
      origin: 'ABQ',
      destination: 'NAP',
      city: 'Naples',
      country: 'Italy',
      cabin: 'economy' as const,
      tripType,
    });

    const wknd = processCandidate(db, cand('weekend'), '2026-06-20 08:00:00');
    const week = processCandidate(db, cand('one_week'), '2026-06-20 08:00:00');
    expect(wknd?.tripType).toBe('weekend');
    expect(wknd?.bestPriceCents).toBe(55000);
    expect(week?.tripType).toBe('one_week');
    expect(week?.bestPriceCents).toBe(62000);
    expect(wknd?.id).not.toBe(week?.id); // two rows, not one overwriting the other

    // Both surface on the feed as separate deals to the same city.
    const deals = activeDealsWithPlace(db, 'mock', ['economy'], ['weekend', 'one_week', 'two_weeks']).filter((d) => d.destination === 'NAP');
    expect(deals).toHaveLength(2);
    expect(deals.map((d) => d.tripType).sort()).toEqual(['one_week', 'weekend']);

    // De-selecting a trip type hides its deals (symmetric with cabin filtering).
    expect(activeDealsWithPlace(db, 'mock', ['economy'], ['one_week']).map((d) => d.tripType)).toEqual([
      'one_week',
    ]);
    expect(activeDealsWithPlace(db, 'mock', ['economy'], [])).toHaveLength(0);
  });

  it('scans every monitored trip type in one batch, keying deals per trip type', async () => {
    const db = openDb(':memory:');
    updateSettings(db, {
      monitoredCabins: ['economy'],
      tripTypes: ['weekend', 'one_week', 'two_weeks'],
      dailyCallBudget: 2000,
    });
    const provider = new SyntheticProvider({ seed: 1 });
    await runScanBatch({ db, config, provider });
    // Snapshots exist for all three trip types (the loop ran each combo).
    const tripTypes = (db.prepare('SELECT DISTINCT trip_type FROM price_snapshots').all() as {
      trip_type: string;
    }[]).map((r) => r.trip_type).sort();
    expect(tripTypes).toEqual(['one_week', 'two_weeks', 'weekend']);
  });
});

describe('settings monitoredCabins', () => {
  it('defaults to economy + premium economy and round-trips a subset', () => {
    const db = openDb(':memory:');
    expect(getSettings(db, config).monitoredCabins).toEqual(['economy', 'premium_economy']);

    updateSettings(db, { monitoredCabins: ['business', 'economy', 'first'] });
    // Stored in canonical CABINS order regardless of input order
    expect(getSettings(db, config).monitoredCabins).toEqual(['economy', 'business', 'first']);
  });

  it('never scans an unmonitored cabin', async () => {
    const db = openDb(':memory:');
    updateSettings(db, { monitoredCabins: ['premium_economy'], dailyCallBudget: 2000 });
    const provider = new SyntheticProvider({ seed: 1 });
    await runScanBatch({ db, config, provider });
    const cabins = (db.prepare('SELECT DISTINCT cabin FROM price_snapshots').all() as {
      cabin: string;
    }[]).map((r) => r.cabin);
    expect(cabins).toEqual(['premium_economy']);
  });
});
