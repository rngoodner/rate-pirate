import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { recentEvents, seedDestinations } from '../db/repo.js';
import { updateSettings } from '../db/settings.js';
import { loadConfig } from '../config.js';
import { DESTINATION_CATALOG } from '../scanner/destinations.js';
import { SyntheticProvider } from '../providers/mock.js';
import { runScanBatch, type ScanDeps } from '../scanner/scan.js';
import type { FlightPriceProvider } from '../providers/types.js';

function makeDeps(provider?: FlightPriceProvider): ScanDeps {
  const db = openDb(':memory:');
  seedDestinations(db, DESTINATION_CATALOG);
  return { db, config: loadConfig({}), provider: provider ?? new SyntheticProvider({ seed: 7 }) };
}

describe('runScanBatch guards', () => {
  it('refuses to run two batches concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: FlightPriceProvider = {
      name: 'mock',
      monthQuotes: async (q) => {
        await gate;
        return new SyntheticProvider({ seed: 7 }).monthQuotes(q);
      },
    };
    const deps = makeDeps(slow);

    const first = runScanBatch(deps, 2);
    const second = await runScanBatch(deps, 2); // while first is mid-flight
    expect(second.skippedReason).toBe('already_running');
    expect(second.planned).toBe(0);

    release();
    const result = await first;
    expect(result.scanned).toBe(2);

    // Once the first finishes, batches run again.
    const third = await runScanBatch(deps, 1);
    expect(third.skippedReason).toBeUndefined();
    expect(third.scanned).toBe(1);
  });

  it('flags a sizable all-zero-price batch as possible scraper breakage', async () => {
    const emptyProvider: FlightPriceProvider = {
      name: 'mock',
      monthQuotes: async () => [],
    };
    const deps = makeDeps(emptyProvider);
    const result = await runScanBatch(deps, 12);
    expect(result.scanned).toBe(12);
    expect(result.snapshots).toBe(0);
    const anomaly = recentEvents(deps.db, 10).find((e) => e.level === 'error');
    expect(anomaly).toBeDefined();
    expect(anomaly!.scope).toBe('batch');
    expect(anomaly!.message).toContain('zero prices');
  });

  it('enforces the budget against the LOCAL day when no virtual clock is injected', async () => {
    const deps = makeDeps();
    updateSettings(deps.db, { dailyCallBudget: 10 });
    // 10 calls stamped "now" (UTC storage) — they are today in local terms and
    // must exhaust the budget even during the evening UTC-rollover window.
    for (let i = 0; i < 10; i++) {
      deps.db
        .prepare(
          `INSERT INTO api_calls (provider, endpoint, ok, called_at)
           VALUES ('mock', 'monthQuotes', 1, datetime('now', '-1 minute'))`,
        )
        .run();
    }
    const result = await runScanBatch(deps);
    expect(result.skippedReason).toBe('budget_exhausted');

    // Sanity: with budget headroom the real-clock path scans normally.
    updateSettings(deps.db, { dailyCallBudget: 12 });
    const ok = await runScanBatch(deps);
    expect(ok.scanned).toBe(2);
  });
});
