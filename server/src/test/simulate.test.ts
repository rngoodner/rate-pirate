/** Fast-forward simulator: drives the real scanner against the synthetic
 *  provider with a virtual clock. No network, no real time. */
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { apiCallsToday } from '../db/repo.js';
import { updateSettings } from '../db/settings.js';
import { loadConfig } from '../config.js';
import { SyntheticProvider } from '../providers/mock.js';
import { runScanBatch, sqliteStamp } from '../scanner/scan.js';

const config = loadConfig({});
const START = Date.parse('2026-07-05T06:00:00Z');
const DAY = 86_400_000;
const BATCH_HOURS = [0, 5, 11, 16]; // offsets from 06:00 → 06,11,17,22

function makeSim(dailyBudget: number) {
  const db = openDb(':memory:');
  // Economy-only + one trip type keeps the Explore universe small and stable.
  updateSettings(db, { dailyCallBudget: dailyBudget, monitoredCabins: ['economy'] });
  let virtualNow = new Date(START);
  const provider = new SyntheticProvider({ seed: 42, now: () => virtualNow });
  const deps = { db, config, provider, now: () => virtualNow };

  return {
    db,
    provider,
    deps,
    setNow(d: Date) {
      virtualNow = d;
    },
    async runDay(day: number) {
      const results = [];
      for (const hour of BATCH_HOURS) {
        virtualNow = new Date(START + day * DAY + hour * 3_600_000);
        results.push(await runScanBatch(deps));
      }
      return results;
    },
    callsOnDay(day: number) {
      // 06:00Z start + 16h = 22:00Z — end of the same UTC day
      return apiCallsToday(db, 'mock', sqliteStamp(new Date(START + day * DAY + 16 * 3_600_000)));
    },
  };
}

describe('scan simulation (virtual clock)', () => {
  it('never exceeds the daily budget across a day of batches', async () => {
    const budget = 40;
    const sim = makeSim(budget);
    for (let day = 0; day < 3; day++) {
      await sim.runDay(day);
      expect(sim.callsOnDay(day)).toBeLessThanOrEqual(budget);
    }
  }, 30_000);

  it('scan_enabled=false skips batches entirely', async () => {
    const sim = makeSim(500);
    updateSettings(sim.db, { scanEnabled: false });
    const [result] = await sim.runDay(0);
    expect(result!.skippedReason).toBe('scan_disabled');
    expect(sim.callsOnDay(0)).toBe(0);
  });

  it('budget exhaustion stops further batches', async () => {
    const budget = 30;
    const sim = makeSim(budget);
    const first = await runScanBatch(sim.deps, 8);
    expect(first.scanned).toBeGreaterThan(0);

    // Keep hitting the same day until the budget is spent, then it must skip.
    let last = first;
    for (let i = 0; i < 12; i++) last = await runScanBatch(sim.deps, 8);
    expect(last.skippedReason).toBe('budget_exhausted');
    expect(apiCallsToday(sim.db, 'mock', sqliteStamp(new Date(START)))).toBeLessThanOrEqual(budget);
  }, 30_000);
});
