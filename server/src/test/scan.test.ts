import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { activeDealsWithPlace, recentEvents } from '../db/repo.js';
import { updateSettings } from '../db/settings.js';
import { loadConfig } from '../config.js';
import { SyntheticProvider } from '../providers/mock.js';
import {
  requestUniverseRescan,
  runDealVerification,
  runScanBatch,
  type ScanDeps,
} from '../scanner/scan.js';
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

  it('queues a universe-change rescan when a batch is in flight (does not drop it)', async () => {
    // A settings change mid-scan (e.g. party size 1→2) must not be lost to the
    // batch mutex: the fresh scan has to run after the in-flight (old-settings)
    // one, or the feed keeps showing stale prices.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = new SyntheticProvider({ seed: 7 });
    let explores = 0;
    let secondReached!: () => void;
    const secondDone = new Promise<void>((r) => (secondReached = r));
    const provider: FlightPriceProvider = {
      name: 'mock',
      exploreSearch: async (q: ExploreQuery) => {
        explores++;
        if (explores === 1) await gate; // hold the first batch in flight
        if (explores === 2) secondReached(); // the queued rescan got here
        return inner.exploreSearch(q);
      },
      monthQuotes: (q: MonthQuery) => inner.monthQuotes(q),
    };
    const deps = makeDeps(provider);
    updateSettings(deps.db, { monitoredCabins: ['economy'], tripTypes: ['one_week'] });

    const first = runScanBatch(deps); // synchronously takes the mutex, blocks on the gate
    requestUniverseRescan(deps); // batch in flight → must queue, not drop
    release();
    await first; // first batch finishes → fires the queued rescan
    await secondDone; // deterministically confirms the rescan actually ran
    await new Promise((r) => setTimeout(r, 50)); // let it finish (release the mutex)
    expect(explores).toBe(2);
  }, 30_000);

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

  it('flags Explore returning zero destinations across all searches as breakage', async () => {
    // Searches "succeed" (page loads) but discover nothing — the signature of
    // Google changing the Explore RPC. scanned stays 0, so the zero-price check
    // can't catch it; the zero-destinations check must.
    const emptyExplore: FlightPriceProvider = {
      name: 'mock',
      exploreSearch: async () => [],
      monthQuotes: async () => ({ quotes: [], insights: null }),
    };
    const deps = makeDeps(emptyExplore);
    updateSettings(deps.db, { monitoredCabins: ['economy'], tripTypes: ['weekend', 'one_week'] });
    const result = await runScanBatch(deps);
    expect(result.scanned).toBe(0);
    expect(result.planned).toBe(0);
    const anomaly = recentEvents(deps.db, 10).find(
      (e) => e.level === 'error' && /zero destinations/.test(e.message),
    );
    expect(anomaly).toBeDefined();
    expect(anomaly!.scope).toBe('batch');
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
    expect(activeDealsWithPlace(db, 'mock', ['economy'], ['weekend', 'one_week', 'two_weeks']).some((d) => d.destination === 'CUN')).toBe(true);

    // Fares vanish. batchLimit 0 means the main loop scans nothing, so ONLY the
    // post-scan verification pass runs — and it must drop the now-gone deal.
    faresGone = true;
    virtualNow = new Date(Date.parse('2026-07-05T06:00:00Z') + 86_400_000);
    await runScanBatch(deps, 0);
    expect(activeDealsWithPlace(db, 'mock', ['economy'], ['weekend', 'one_week', 'two_weeks']).some((d) => d.destination === 'CUN')).toBe(
      false,
    );
    expect(recentEvents(db, 20).some((e) => /verified \d+ shown deal.*dropped/.test(e.message))).toBe(
      true,
    );
  }, 30_000);

  it('expires a shown deal once Explore stops ranking its destination (inherent verification)', async () => {
    const db = openDb(':memory:');
    updateSettings(db, { dailyCallBudget: 2000, monitoredCabins: ['economy'], tripTypes: ['one_week'] });
    const config = loadConfig({});
    const inner = new SyntheticProvider({ seed: 3 });
    let listCun = true;
    let virtualNow = new Date('2026-07-05T06:00:00Z');
    // Explore keeps returning a full, priced list every batch — but CUN drops
    // out of the ranking on the second batch. Fares never vanish (distinct from
    // the empty-monthQuotes path): CUN must expire because it's no longer seen.
    const provider: FlightPriceProvider = {
      name: 'mock',
      exploreSearch: async (q: ExploreQuery) => {
        const all = await inner.exploreSearch(q);
        return listCun ? all : all.filter((d) => d.iata !== 'CUN');
      },
      monthQuotes: (q: MonthQuery) => inner.monthQuotes(q),
    };
    const deps: ScanDeps = {
      db,
      config,
      provider,
      now: () => virtualNow,
      onQuotes: createOnQuotes(db, config, { name: 'console', send: async () => {} }, 'mock', () => virtualNow),
    };

    const cun = (await provider.exploreSearch({ origin: 'ABQ', cabin: 'economy', tripType: 'one_week', adults: 1 })).find(
      (d) => d.iata === 'CUN',
    )!;
    inner.injectDrop('CUN', cun.departDate.slice(0, 7), 0.5);
    await runScanBatch(deps);
    expect(activeDealsWithPlace(db, 'mock', ['economy'], ['weekend', 'one_week', 'two_weeks']).some((d) => d.destination === 'CUN')).toBe(true);
    const othersBefore = activeDealsWithPlace(db, 'mock', ['economy'], ['weekend', 'one_week', 'two_weeks']).length;

    // Next batch: CUN gone from Explore, everything else still priced.
    listCun = false;
    virtualNow = new Date(Date.parse('2026-07-05T06:00:00Z') + 86_400_000);
    await runScanBatch(deps);
    const active = activeDealsWithPlace(db, 'mock', ['economy'], ['weekend', 'one_week', 'two_weeks']);
    expect(active.some((d) => d.destination === 'CUN')).toBe(false); // expired: no longer seen
    expect(active.length).toBeGreaterThan(0); // the rest of the feed is untouched
    expect(othersBefore).toBeGreaterThan(1); // sanity: Explore did return a full list
  }, 30_000);

  it('verifies a shown deal the score budget did not reach in its own scanned combo', async () => {
    // The gap: a combo IS scanned (some candidates scored), but the score limit
    // stops before a shown deal's destination. That deal must still be re-priced
    // by the post-scan pass — not skipped just because its combo ran.
    const db = openDb(':memory:');
    updateSettings(db, { dailyCallBudget: 2000, monitoredCabins: ['economy'], tripTypes: ['one_week'] });
    const config = loadConfig({});
    const inner = new SyntheticProvider({ seed: 3 });
    const dests = ['AAA', 'BBB', 'CCC'].map((iata) => ({
      iata,
      city: iata,
      country: 'X',
      departDate: '2026-09-07',
      returnDate: '2026-09-14',
    }));
    for (const d of dests) inner.injectDrop(d.iata, '2026-09', 0.5); // deep drop → each is a deal
    let cGone = false;
    const virtualNow = new Date('2026-08-15T06:00:00Z');
    const provider: FlightPriceProvider = {
      name: 'mock',
      exploreSearch: async () => dests, // all three keep ranking
      monthQuotes: async (q: MonthQuery): Promise<MonthResult> =>
        q.destination === 'CCC' && cGone ? { quotes: [], insights: null } : inner.monthQuotes(q),
    };
    const deps: ScanDeps = {
      db,
      config,
      provider,
      now: () => virtualNow,
      onQuotes: createOnQuotes(db, config, { name: 'console', send: async () => {} }, 'mock', () => virtualNow),
    };

    // Batch 1: all three become active deals.
    await runScanBatch(deps);
    expect(activeDealsWithPlace(db, 'mock', ['economy'], ['weekend', 'one_week', 'two_weeks']).map((d) => d.destination).sort()).toEqual([
      'AAA',
      'BBB',
      'CCC',
    ]);

    // Batch 2: CCC's fare vanishes, but the score limit (2) stops after the first
    // two shown deals — CCC is never re-priced by the main loop, yet still ranks
    // in Explore (so expireDealsNotSeen keeps it). The verify pass must drop it.
    cGone = true;
    const r = await runScanBatch(deps, 2);
    expect(r.scanned).toBe(2); // main loop honored the score limit
    const active = activeDealsWithPlace(db, 'mock', ['economy'], ['weekend', 'one_week', 'two_weeks']).map((d) => d.destination).sort();
    expect(active).toEqual(['AAA', 'BBB']); // CCC dropped despite its combo being scanned
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

    // overrideBudget (the Advanced "run anyway" path) scans despite the spent
    // budget; scoreLimit still bounds it to one batch.
    const forced = await runScanBatch(deps, undefined, { overrideBudget: true });
    expect(forced.skippedReason).toBeUndefined();
    expect(forced.scanned).toBeGreaterThan(0);

    // Sanity: with budget headroom the real-clock path scans normally.
    updateSettings(deps.db, { dailyCallBudget: 40 });
    const ok = await runScanBatch(deps);
    expect(ok.skippedReason).toBeUndefined();
    expect(ok.scanned).toBeGreaterThan(0);
  });

  it('runDealVerification honors overrideBudget when the budget is spent', async () => {
    const deps = makeDeps();
    updateSettings(deps.db, { dailyCallBudget: 5 });
    for (let i = 0; i < 5; i++) {
      deps.db
        .prepare(
          `INSERT INTO api_calls (provider, endpoint, ok, called_at)
           VALUES ('mock', 'monthQuotes', 1, datetime('now', '-1 minute'))`,
        )
        .run();
    }
    expect((await runDealVerification(deps)).skippedReason).toBe('budget_exhausted');
    expect((await runDealVerification(deps, { overrideBudget: true })).skippedReason).toBeUndefined();
  });
});
