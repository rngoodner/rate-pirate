import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { activeDealsWithPlace, recentEvents } from '../db/repo.js';
import { updateSettings } from '../db/settings.js';
import { loadConfig } from '../config.js';
import { SyntheticProvider } from '../providers/mock.js';
import { runScanBatch, type ScanDeps } from '../scanner/scan.js';
import { createOnQuotes } from '../pipeline.js';
import type { ExploreQuery, FlightPriceProvider, MonthQuery, MonthResult } from '../providers/types.js';

function makeDeps(provider?: FlightPriceProvider): ScanDeps {
  const db = openDb(':memory:');
  return { db, config: loadConfig({}), provider: provider ?? new SyntheticProvider({ seed: 7 }) };
}

describe('runScanBatch guards', () => {
  it('refuses to run two batches concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = new SyntheticProvider({ seed: 7 });
    const slow: FlightPriceProvider = {
      name: 'mock',
      // Explore must list destinations so there is something to score.
      exploreSearch: (q: ExploreQuery) => inner.exploreSearch(q),
      monthQuotes: async (q) => {
        await gate;
        return inner.monthQuotes(q);
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
    const inner = new SyntheticProvider({ seed: 7 });
    const emptyProvider: FlightPriceProvider = {
      name: 'mock',
      exploreSearch: (q: ExploreQuery) => inner.exploreSearch(q),
      monthQuotes: async () => ({ quotes: [], insights: null }),
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

  it('drops a shown deal once its fares vanish (post-scan verification)', async () => {
    const db = openDb(':memory:');
    updateSettings(db, { dailyCallBudget: 2000, monitoredCabins: ['economy'] });
    const config = loadConfig({});
    const inner = new SyntheticProvider({ seed: 3 });
    let faresGone = false;
    let virtualNow = new Date('2026-07-05T06:00:00Z');
    // Explore only ever surfaces CUN; its fares are real until we flip `faresGone`.
    const provider: FlightPriceProvider = {
      name: 'mock',
      exploreSearch: async (q: ExploreQuery) =>
        (await inner.exploreSearch(q)).filter((d) => d.iata === 'CUN'),
      monthQuotes: async (q: MonthQuery): Promise<MonthResult> =>
        faresGone ? { quotes: [], insights: null } : inner.monthQuotes(q),
    };
    const deps: ScanDeps = {
      db,
      config,
      provider,
      now: () => virtualNow,
      onQuotes: createOnQuotes(db, config, { name: 'console', send: async () => {} }, 'mock', () => virtualNow),
    };

    // Inject a deep drop on CUN's Explore month so a deal exists and shows.
    const cun = (await provider.exploreSearch({ origin: 'ABQ', cabin: 'economy', tripType: 'one_week', adults: 1 }))[0]!;
    inner.injectDrop('CUN', cun.departDate.slice(0, 7), 0.5);
    await runScanBatch(deps);
    expect(activeDealsWithPlace(db, 'mock', ['economy']).some((d) => d.destination === 'CUN')).toBe(true);

    // Fares vanish. batchLimit 0 means the main loop scans nothing, so ONLY the
    // post-scan verification pass runs — and it must drop the now-gone deal.
    faresGone = true;
    virtualNow = new Date(Date.parse('2026-07-05T06:00:00Z') + 86_400_000);
    await runScanBatch(deps, 0);
    expect(activeDealsWithPlace(db, 'mock', ['economy']).some((d) => d.destination === 'CUN')).toBe(
      false,
    );
    expect(recentEvents(db, 20).some((e) => /verified \d+ shown deal.*dropped/.test(e.message))).toBe(
      true,
    );
  }, 30_000);

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
    updateSettings(deps.db, { dailyCallBudget: 40 });
    const ok = await runScanBatch(deps);
    expect(ok.skippedReason).toBeUndefined();
    expect(ok.scanned).toBeGreaterThan(0);
  });
});
