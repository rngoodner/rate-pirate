/** Fast-forward simulator: drives the real scanner against the synthetic
 *  provider with a virtual clock. No network, no real time. */
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { apiCallsToday, latestCaptureByRouteMonth, seedDestinations } from '../db/repo.js';
import { updateSettings } from '../db/settings.js';
import { loadConfig } from '../config.js';
import { DESTINATION_CATALOG } from '../scanner/destinations.js';
import { SyntheticProvider } from '../providers/mock.js';
import { runScanBatch, sqliteStamp } from '../scanner/scan.js';
import { horizonMonths } from '../scanner/planner.js';

const config = loadConfig({});
const START = Date.parse('2026-07-05T06:00:00Z');
const DAY = 86_400_000;
const BATCH_HOURS = [0, 5, 11, 16]; // offsets from 06:00 → 06,11,17,22

function makeSim(dailyBudget: number) {
  const db = openDb(':memory:');
  seedDestinations(db, DESTINATION_CATALOG);
  // Economy-only keeps the universe at destinations × 6 for these budget assertions.
  updateSettings(db, { dailyCallBudget: dailyBudget, monitoredCabins: ['economy'] });
  let virtualNow = new Date(START);
  const provider = new SyntheticProvider({ seed: 42, now: () => virtualNow });
  const deps = { db, config, provider, now: () => virtualNow };

  return {
    db,
    provider,
    async runDay(day: number) {
      const results = [];
      for (const hour of BATCH_HOURS) {
        virtualNow = new Date(START + day * DAY + hour * 3_600_000);
        results.push(await runScanBatch(deps));
      }
      return results;
    },
    callsOnDay(day: number) {
      // 06:00Z start + 17h = 23:00Z — end of the same UTC day
      return apiCallsToday(db, 'mock', sqliteStamp(new Date(START + day * DAY + 17 * 3_600_000)));
    },
  };
}

describe('30-day scan simulation', () => {
  it('generous budget: whole universe scanned daily, budget never exceeded', async () => {
    const universe = DESTINATION_CATALOG.length * 6; // 558
    const budget = 600;
    const sim = makeSim(budget);

    for (let day = 0; day < 3; day++) {
      await sim.runDay(day);
      expect(sim.callsOnDay(day)).toBeLessThanOrEqual(budget);
      expect(sim.callsOnDay(day)).toBe(universe); // nothing more to scan than the universe
    }
    const latest = latestCaptureByRouteMonth(sim.db, 'mock', 'ABQ');
    expect(latest.size).toBe(universe);
  }, 30_000);

  it('tight budget (60/day): budget enforced, tier-1 cycles fastest, full pass within 30 days', async () => {
    const sim = makeSim(60);

    for (let day = 0; day < 30; day++) {
      await sim.runDay(day);
      expect(sim.callsOnDay(day)).toBeLessThanOrEqual(60);
    }

    const latest = latestCaptureByRouteMonth(sim.db, 'mock', 'ABQ');
    const months = horizonMonths(new Date(START + 29 * DAY), 6);
    // Near-horizon months of every tier-1 favorite stay fresh (≤ ~3 days stale at the end)
    const endOfRun = START + 30 * DAY;
    for (const d of DESTINATION_CATALOG.filter((d) => d.tier === 1)) {
      for (const month of months.slice(0, 2)) {
        const captured = latest.get(`${d.iata}|${month}|economy`);
        expect(captured, `${d.iata}|${month} never scanned`).toBeTruthy();
        const age = endOfRun - Date.parse(captured!.replace(' ', 'T') + 'Z');
        expect(age, `${d.iata}|${month} stale ${Math.round(age / DAY)}d`).toBeLessThanOrEqual(3.5 * DAY);
      }
    }
    // Every route-month in the universe was scanned at least once (the run crosses
    // into August, so a 7th month enters the horizon and the map can exceed 6/dest)
    expect(latest.size).toBeGreaterThanOrEqual(DESTINATION_CATALOG.length * 6);
  }, 60_000);

  it('scan_enabled=false skips batches entirely', async () => {
    const sim = makeSim(500);
    updateSettings(sim.db, { scanEnabled: false });
    const [result] = await sim.runDay(0);
    expect(result!.skippedReason).toBe('scan_disabled');
    expect(sim.callsOnDay(0)).toBe(0);
  });

  it('budget exhaustion stops further batches', async () => {
    const db = openDb(':memory:');
    seedDestinations(db, DESTINATION_CATALOG);
    updateSettings(db, { dailyCallBudget: 10 });
    const virtualNow = new Date(START);
    const provider = new SyntheticProvider({ seed: 42, now: () => virtualNow });
    const deps = { db, config, provider, now: () => virtualNow };

    const first = await runScanBatch(deps, 8);
    expect(first.scanned).toBe(8);
    const second = await runScanBatch(deps, 8); // only 2 left in the daily budget
    expect(second.scanned).toBe(2);
    const third = await runScanBatch(deps, 8);
    expect(third.skippedReason).toBe('budget_exhausted');
    expect(apiCallsToday(db, 'mock', sqliteStamp(virtualNow))).toBe(10);
  });
});
