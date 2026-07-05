import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { maybeAlert } from '../alerts/notify.js';
import type { EmailMessage, EmailSender } from '../alerts/email.js';
import { upsertDeal, type DealRow } from '../db/repo.js';
import type { Settings } from '@rate-pirate/shared';

const settings: Settings = {
  homeAirport: 'ABQ',
  alertEmail: 'me@example.com',
  alertThreshold: 85,
  dailyCallBudget: 500,
  scanEnabled: true,
};

function fakeSender() {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = {
    name: 'console',
    send: async (msg) => {
      sent.push(msg);
    },
  };
  return { sender, sent };
}

function makeDeal(
  db: ReturnType<typeof openDb>,
  overrides: Partial<Parameters<typeof upsertDeal>[1]> = {},
): DealRow {
  return upsertDeal(db, {
    origin: 'ABQ',
    destination: 'NAP',
    travelMonth: '2026-08',
    bestPriceCents: 65000,
    baselinePriceCents: 100000,
    discountPct: 0.35,
    score: 93,
    departDate: '2026-08-18',
    returnDate: '2026-08-26',
    seenAt: '2026-06-20 08:00:00',
    ...overrides,
  });
}

describe('maybeAlert', () => {
  it('sends when score and discount clear the bars', async () => {
    const db = openDb(':memory:');
    const { sender, sent } = fakeSender();
    const result = await maybeAlert(db, makeDeal(db), settings, sender, '2026-06-20 08:00:00');
    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('me@example.com');
    expect(sent[0]!.subject).toContain('$650');
    expect(sent[0]!.subject).toContain('35% off');
  });

  it('skips below the score threshold and below the discount floor', async () => {
    const db = openDb(':memory:');
    const { sender, sent } = fakeSender();
    const lowScore = await maybeAlert(
      db,
      makeDeal(db, { score: 80 }),
      settings,
      sender,
      '2026-06-20 08:00:00',
    );
    expect(lowScore).toEqual({ sent: false, reason: 'below_threshold' });

    const shallow = await maybeAlert(
      db,
      makeDeal(db, { score: 90, bestPriceCents: 85000, discountPct: 0.15 }),
      settings,
      sender,
      '2026-06-20 08:00:00',
    );
    expect(shallow).toEqual({ sent: false, reason: 'below_min_discount' });
    expect(sent).toHaveLength(0);
  });

  it('enforces the 7-day cooldown', async () => {
    const db = openDb(':memory:');
    const { sender, sent } = fakeSender();
    const deal = makeDeal(db);
    await maybeAlert(db, deal, settings, sender, '2026-06-20 08:00:00');
    const again = await maybeAlert(db, deal, settings, sender, '2026-06-23 08:00:00');
    expect(again).toEqual({ sent: false, reason: 'cooldown' });
    const afterCooldown = await maybeAlert(db, deal, settings, sender, '2026-06-28 09:00:00');
    expect(afterCooldown.sent).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('re-alerts within cooldown when the deal deepens ≥10%', async () => {
    const db = openDb(':memory:');
    const { sender, sent } = fakeSender();
    const deal = makeDeal(db);
    await maybeAlert(db, deal, settings, sender, '2026-06-20 08:00:00');

    const deeper = makeDeal(db, { bestPriceCents: 57000, discountPct: 0.43, score: 97 });
    const result = await maybeAlert(db, deeper, settings, sender, '2026-06-22 08:00:00');
    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(2);

    // A tiny further dip (<10% below last alerted price) stays silenced
    const slight = makeDeal(db, { bestPriceCents: 55000, discountPct: 0.45, score: 97 });
    const silenced = await maybeAlert(db, slight, settings, sender, '2026-06-23 08:00:00');
    expect(silenced).toEqual({ sent: false, reason: 'cooldown' });
  });

  it('skips when no recipient is configured', async () => {
    const db = openDb(':memory:');
    const { sender } = fakeSender();
    const result = await maybeAlert(
      db,
      makeDeal(db),
      { ...settings, alertEmail: '' },
      sender,
      '2026-06-20 08:00:00',
    );
    expect(result).toEqual({ sent: false, reason: 'no_recipient' });
  });

  it('reports send failures without recording an alert (retries next scan)', async () => {
    const db = openDb(':memory:');
    const failing: EmailSender = {
      name: 'console',
      send: async () => {
        throw new Error('boom');
      },
    };
    const deal = makeDeal(db);
    const result = await maybeAlert(db, deal, settings, failing, '2026-06-20 08:00:00');
    expect(result).toEqual({ sent: false, reason: 'send_failed' });

    const { sender, sent } = fakeSender();
    const retry = await maybeAlert(db, deal, settings, sender, '2026-06-20 12:00:00');
    expect(retry.sent).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
