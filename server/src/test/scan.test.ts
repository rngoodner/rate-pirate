import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { dormantRouteMonths, recentEvents, seedDestinations } from '../db/repo.js';
import { updateSettings } from '../db/settings.js';
import { loadConfig } from '../config.js';
import { DESTINATION_CATALOG } from '../scanner/destinations.js';
import { SyntheticProvider } from '../providers/mock.js';
import { runScanBatch, sqliteStamp, type ScanDeps } from '../scanner/scan.js';
import type { FlightPriceProvider, MonthQuery } from '../providers/types.js';

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

  it('puts a reliably-empty pair to sleep after 5 empty scans, then re-probes', async () => {
    // One destination returns fares only for economy; business is always empty.
    const db = openDb(':memory:');
    seedDestinations(db, [
      { iata: 'CUN', city: 'Cancún', country: 'Mexico', region: 'americas', tier: 1 },
    ]);
    updateSettings(db, { dailyCallBudget: 2000, monitoredCabins: ['economy', 'business'] });
    const inner = new SyntheticProvider({ seed: 7 });
    let virtualNow = new Date('2026-07-05T06:00:00Z');
    const provider: FlightPriceProvider = {
      name: 'mock',
      monthQuotes: async (q: MonthQuery) =>
        q.cabin === 'business' ? { quotes: [], insights: null } : inner.monthQuotes(q),
    };
    const deps = { db, config: loadConfig({}), provider, now: () => virtualNow };

    // Advance ~a day between batches so MIN_STALE_HOURS lets each pair re-plan.
    const businessDormant = () =>
      dormantRouteMonths(db, 'mock', 'ABQ', 5, 14, sqliteStamp(virtualNow));
    for (let day = 0; day < 6; day++) {
      virtualNow = new Date(Date.parse('2026-07-05T06:00:00Z') + day * 86_400_000);
      await runScanBatch(deps);
    }
    // Every business route-month (6 months) has gone dormant; economy never does.
    const dormant = businessDormant();
    expect(dormant.size).toBe(6);
    expect([...dormant].every((k) => k.endsWith('|business'))).toBe(true);

    // 20 days later the rest window has lapsed → nothing suppressed (re-probe).
    virtualNow = new Date(Date.parse('2026-07-05T06:00:00Z') + 30 * 86_400_000);
    expect(businessDormant().size).toBe(0);
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
    updateSettings(deps.db, { dailyCallBudget: 12 });
    const ok = await runScanBatch(deps);
    expect(ok.scanned).toBe(2);
  });
});
