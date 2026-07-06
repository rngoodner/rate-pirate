import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import {
  activeDealsWithPlace,
  insertSnapshot,
  latestCaptureByRouteMonth,
  routeMonthsWithBaseline,
  seedDestinations,
  snapshotsForRoute,
} from '../db/repo.js';
import { getSettings, updateSettings } from '../db/settings.js';
import { loadConfig } from '../config.js';
import { processRouteMonth } from '../deals/detect.js';
import { planBatch } from '../scanner/planner.js';
import { DESTINATION_CATALOG } from '../scanner/destinations.js';
import { SyntheticProvider } from '../providers/mock.js';
import type { Cabin } from '@rate-pirate/shared';

const config = loadConfig({});

function insertHistory(
  db: ReturnType<typeof openDb>,
  cabin: Cabin,
  priceCents: number,
  days = 12,
) {
  for (let day = 1; day <= days; day++) {
    insertSnapshot(db, {
      origin: 'ABQ',
      destination: 'NAP',
      cabin,
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

describe('cabin isolation', () => {
  it('keeps snapshots and baselines separate per cabin', () => {
    const db = openDb(':memory:');
    insertHistory(db, 'economy', 100000);
    insertHistory(db, 'business', 400000);

    expect(snapshotsForRoute(db, 'mock', 'ABQ', 'NAP', 'economy', 90)).toHaveLength(12);
    expect(snapshotsForRoute(db, 'mock', 'ABQ', 'NAP', 'business', 90)).toHaveLength(12);

    const latest = latestCaptureByRouteMonth(db, 'mock', 'ABQ');
    expect(latest.get('NAP|2026-08|economy')).toBeTruthy();
    expect(latest.get('NAP|2026-08|business')).toBeTruthy();
  });

  it('detects an independent deal in each cabin', () => {
    const db = openDb(':memory:');
    insertHistory(db, 'economy', 100000);
    insertHistory(db, 'business', 400000);
    // A cheap fresh scan in each cabin
    insertSnapshot(db, {
      origin: 'ABQ', destination: 'NAP', cabin: 'economy', travelMonth: '2026-08',
      departDate: '2026-08-10', returnDate: '2026-08-17', priceCents: 62000,
      stops: 1, carrier: 'AA', source: 'mock', capturedAt: '2026-06-20 08:00:00',
    });
    insertSnapshot(db, {
      origin: 'ABQ', destination: 'NAP', cabin: 'business', travelMonth: '2026-08',
      departDate: '2026-08-10', returnDate: '2026-08-17', priceCents: 250000,
      stops: 1, carrier: 'AA', source: 'mock', capturedAt: '2026-06-20 08:00:00',
    });

    const econ = processRouteMonth(
      db, { source: 'mock', origin: 'ABQ', destination: 'NAP', cabin: 'economy', month: '2026-08' },
      '2026-06-20 08:00:00',
    );
    const biz = processRouteMonth(
      db, { source: 'mock', origin: 'ABQ', destination: 'NAP', cabin: 'business', month: '2026-08' },
      '2026-06-20 08:00:00',
    );
    expect(econ?.cabin).toBe('economy');
    expect(econ?.bestPriceCents).toBe(62000);
    expect(econ?.baselinePriceCents).toBe(100000);
    expect(biz?.cabin).toBe('business');
    expect(biz?.bestPriceCents).toBe(250000);
    expect(biz?.baselinePriceCents).toBe(400000);

    // The feed only shows monitored cabins
    expect(activeDealsWithPlace(db, 'mock', ['economy']).map((d) => d.cabin)).toEqual(['economy']);
    expect(
      activeDealsWithPlace(db, 'mock', ['economy', 'business']).map((d) => d.cabin).sort(),
    ).toEqual(['business', 'economy']);
    expect(activeDealsWithPlace(db, 'mock', [])).toHaveLength(0);
  });

  it('counts baseline coverage per monitored cabin', () => {
    const db = openDb(':memory:');
    insertHistory(db, 'economy', 100000); // 12 days -> has baseline
    insertHistory(db, 'business', 400000, 5); // 5 days -> no baseline
    expect(routeMonthsWithBaseline(db, 'mock', 'ABQ', ['economy'])).toBe(1);
    expect(routeMonthsWithBaseline(db, 'mock', 'ABQ', ['business'])).toBe(0);
    expect(routeMonthsWithBaseline(db, 'mock', 'ABQ', ['economy', 'business'])).toBe(1);
  });
});

describe('planner with cabins', () => {
  const dest = (iata: string, tier: number) => ({
    iata, city: iata, country: 'X', region: 'europe', tier, active: true,
  });

  it('expands the universe by the number of cabins', () => {
    const one = planBatch({
      destinations: [dest('AAA', 1)], cabins: ['economy'],
      latestCapture: new Map(), now: new Date('2026-07-05T12:00:00Z'), horizon: 6, limit: 100,
    });
    const three = planBatch({
      destinations: [dest('AAA', 1)], cabins: ['economy', 'business', 'first'],
      latestCapture: new Map(), now: new Date('2026-07-05T12:00:00Z'), horizon: 6, limit: 100,
    });
    expect(one).toHaveLength(6); // 1 dest × 6 months
    expect(three).toHaveLength(18); // × 3 cabins
    expect(new Set(three.map((t) => t.cabin))).toEqual(new Set(['economy', 'business', 'first']));
  });

  it('scans nothing when no cabins are selected', () => {
    expect(
      planBatch({
        destinations: [dest('AAA', 1)], cabins: [],
        latestCapture: new Map(), now: new Date(), horizon: 6, limit: 100,
      }),
    ).toHaveLength(0);
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
    seedDestinations(db, DESTINATION_CATALOG);
    updateSettings(db, { monitoredCabins: ['premium_economy'] });
    const provider = new SyntheticProvider({ seed: 1 });
    const { monitoredCabins } = getSettings(db, config);
    const tasks = planBatch({
      destinations: DESTINATION_CATALOG.map((d) => ({ ...d, active: true })),
      cabins: monitoredCabins,
      latestCapture: new Map(),
      now: new Date('2026-07-05T12:00:00Z'),
      horizon: 6,
      limit: 1000,
    });
    expect(tasks.every((t) => t.cabin === 'premium_economy')).toBe(true);
    // sanity: mock returns quotes for that cabin
    const { quotes } = await provider.monthQuotes({
      origin: 'ABQ', destination: 'NAP', cabin: 'premium_economy', month: '2026-08',
    });
    expect(quotes.every((q) => q.cabin === 'premium_economy')).toBe(true);
  });
});
