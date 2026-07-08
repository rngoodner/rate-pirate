/** End-to-end: scanner (Explore-discover → fixed-date-score) → deal detection →
 *  email, on a virtual clock. Injects a drop on NAP and checks the alert
 *  behavior including day-one bootstrapping, cooldown, and deepening re-alerts. */
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { getDealByCombo } from '../db/repo.js';
import { updateSettings } from '../db/settings.js';
import { loadConfig } from '../config.js';
import { SyntheticProvider } from '../providers/mock.js';
import { runScanBatch } from '../scanner/scan.js';
import { createOnQuotes } from '../pipeline.js';
import type { EmailMessage, EmailSender } from '../alerts/email.js';

const START = Date.parse('2026-07-05T06:00:00Z');
const DAY = 86_400_000;

describe('alert pipeline simulation', () => {
  it('one alert on the injected drop, cooldown after, re-alert on deepening', async () => {
    const db = openDb(':memory:');
    // Economy-only so the injected drop yields exactly one NAP deal.
    updateSettings(db, {
      dailyCallBudget: 2000,
      alertEmail: 'me@example.com',
      monitoredCabins: ['economy'],
    });
    const config = loadConfig({});

    let virtualNow = new Date(START);
    const now = () => virtualNow;
    const provider = new SyntheticProvider({ seed: 42, now });
    const sent: { day: number; msg: EmailMessage }[] = [];
    let currentDay = 0;
    const sender: EmailSender = {
      name: 'console',
      send: async (msg) => {
        sent.push({ day: currentDay, msg });
      },
    };
    const deps = { db, config, provider, now, onQuotes: createOnQuotes(db, config, sender, 'mock', now) };
    // The Explore combo is one NAP deal regardless of month; organic drops on
    // other destinations don't say "Naples".
    const napAlerts = () => sent.filter((s) => s.msg.subject.includes('Naples'));

    // Explore picks NAP's dates fresh each day; inject the drop for that day's
    // departure month so the fixed-date fetch actually undercuts the baseline.
    async function runDay(day: number, dropMult?: number) {
      currentDay = day;
      virtualNow = new Date(START + day * DAY);
      if (dropMult !== undefined) {
        const nap = (
          await provider.exploreSearch({ origin: 'ABQ', cabin: 'economy', tripType: 'one_week', adults: 1 })
        ).find((d) => d.iata === 'NAP')!;
        provider.injectDrop('NAP', nap.departDate.slice(0, 7), dropMult);
      }
      await runScanBatch(deps, 2000);
    }

    // Day 0: 50% drop lands on NAP → one alert (Google baseline scores it day one).
    await runDay(0, 0.5);
    expect(napAlerts()).toHaveLength(1);
    const first = napAlerts()[0]!;
    expect(first.msg.to).toEqual(['me@example.com']);
    expect(first.msg.subject).toMatch(/score (9\d|100)/);

    // Days 1–2: same price → cooldown, no repeats.
    await runDay(1, 0.5);
    await runDay(2, 0.5);
    expect(napAlerts()).toHaveLength(1);

    // Day 3: the deal deepens well past 10% below the alerted price.
    await runDay(3, 0.4);
    expect(napAlerts()).toHaveLength(2);
    expect(napAlerts()[1]!.day).toBe(3);
  }, 120_000);

  it('bootstraps from Google insights: a drop alerts on DAY ONE of a fresh install', async () => {
    const db = openDb(':memory:');
    updateSettings(db, {
      dailyCallBudget: 2000,
      alertEmail: 'me@example.com',
      monitoredCabins: ['economy'],
    });
    const config = loadConfig({});
    const virtualNow = new Date(START);
    const now = () => virtualNow;
    const provider = new SyntheticProvider({ seed: 42, now });
    const sent: EmailMessage[] = [];
    const sender: EmailSender = {
      name: 'console',
      send: async (msg) => {
        sent.push(msg);
      },
    };
    const deps = { db, config, provider, now, onQuotes: createOnQuotes(db, config, sender, 'mock', now) };

    const nap = (
      await provider.exploreSearch({ origin: 'ABQ', cabin: 'economy', tripType: 'one_week', adults: 1 })
    ).find((d) => d.iata === 'NAP')!;
    provider.injectDrop('NAP', nap.departDate.slice(0, 7), 0.5); // 50% off before the first scan
    await runScanBatch(deps, 2000);

    const deal = getDealByCombo(db, 'mock', 'ABQ', 'NAP', 'economy', 'one_week');
    expect(deal).not.toBeNull();
    expect(deal!.status).toBe('active');
    expect(deal!.discountPct).toBeGreaterThan(0.3);
    const napAlert = sent.find((m) => m.subject.includes('Naples'));
    expect(napAlert).toBeDefined();
  }, 120_000);
});
