/** End-to-end: scanner → deal detection → email, on a virtual clock.
 *  Builds 12 days of price history, injects a 50% drop on NAP, and checks the
 *  alert behavior including cooldown and deepening re-alerts. */
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { seedDestinations } from '../db/repo.js';
import { updateSettings } from '../db/settings.js';
import { loadConfig } from '../config.js';
import { DESTINATION_CATALOG } from '../scanner/destinations.js';
import { SyntheticProvider } from '../providers/mock.js';
import { runScanBatch } from '../scanner/scan.js';
import { horizonMonths } from '../scanner/planner.js';
import { createOnQuotes } from '../pipeline.js';
import type { EmailMessage, EmailSender } from '../alerts/email.js';

const START = Date.parse('2026-07-05T06:00:00Z');
const DAY = 86_400_000;

describe('alert pipeline simulation', () => {
  it('one alert on the injected drop, cooldown after, re-alert on deepening', async () => {
    const db = openDb(':memory:');
    seedDestinations(db, DESTINATION_CATALOG);
    updateSettings(db, { dailyCallBudget: 600, alertEmail: 'me@example.com' });
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

    const dropMonth = horizonMonths(new Date(START), 6)[1]!; // stable across the run
    const monthLabel = new Date(`${dropMonth}-15T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    // Organic synthetic drops can alert on other Naples months; track only ours.
    const napAlerts = () =>
      sent.filter((s) => s.msg.subject.includes('Naples') && s.msg.subject.includes(monthLabel));

    async function runDay(day: number) {
      currentDay = day;
      // One big batch per virtual day is enough for the pipeline test
      virtualNow = new Date(START + day * DAY);
      await runScanBatch(deps, 600);
    }

    // Days 0–11: baseline building. Cold start must stay silent for Naples.
    for (let day = 0; day < 12; day++) await runDay(day);
    expect(napAlerts()).toHaveLength(0);

    // Day 12: 50% drop lands on NAP for one travel month.
    provider.injectDrop('NAP', dropMonth, 0.5);
    await runDay(12);
    expect(napAlerts()).toHaveLength(1);
    const first = napAlerts()[0]!;
    expect(first.msg.to).toBe('me@example.com');
    expect(first.msg.subject).toMatch(/score (9\d|100)/);

    // Days 13–14: same price → cooldown, no repeats.
    await runDay(13);
    await runDay(14);
    expect(napAlerts()).toHaveLength(1);

    // Day 15: the deal deepens well past 10% below the alerted price.
    provider.injectDrop('NAP', dropMonth, 0.4);
    await runDay(15);
    expect(napAlerts()).toHaveLength(2);
    expect(napAlerts()[1]!.day).toBe(15);
  }, 120_000);
});
