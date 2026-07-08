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
import type { Cabin } from '@rate-pirate/shared';

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
    expect(activeDealsWithPlace(db, 'mock', ['economy']).map((d) => d.cabin)).toEqual(['economy']);
    expect(
      activeDealsWithPlace(db, 'mock', ['economy', 'business']).map((d) => d.cabin).sort(),
    ).toEqual(['business', 'economy']);
    expect(activeDealsWithPlace(db, 'mock', [])).toHaveLength(0);
  });

  it('counts distinct (cabin, trip type) combos with a Google baseline', () => {
    const db = openDb(':memory:');
    seedCombo(db, 'economy', 62000, 100000);
    seedCombo(db, 'business', 250000, 400000);
    expect(combosWithBaseline(db, 'mock', 'ABQ')).toBe(2);
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
