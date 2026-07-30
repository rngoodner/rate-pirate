import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { maybeAlert } from '../alerts/notify.js';
import type { EmailMessage, EmailSender } from '../alerts/email.js';
import { insertSnapshot, recentEvents, upsertDeal, type DealRow } from '../db/repo.js';
import type { Settings } from '@rate-pirate/shared';

const settings: Settings = {
  homeAirport: 'ABQ',
  alertEmail: 'me@example.com',
  alertThreshold: 85,
  dailyCallBudget: 500,
  scanEnabled: true,
  monitoredCabins: ['economy'],
  alertMinDiscount: 0.2,
  dealMinDiscount: 0.05,
  alertCooldownDays: 7,
  alertMaxPriceCents: 0,
  tripTypes: ['one_week'],
  adults: 1,
  hiddenAirlines: [],
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
    source: 'mock',
    origin: 'ABQ',
    destination: 'NAP',
    // Left blank so the alert summary falls back to the IATA code (as it does
    // when a deal predates place enrichment) — asserted below.
    city: '',
    country: '',
    cabin: 'economy',
    tripType: 'one_week',
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
    expect(sent[0]!.to).toEqual(['me@example.com']);
    expect(sent[0]!.subject).toContain('$650');
    expect(sent[0]!.subject).toContain('save $350'); // baseline $1000 − price $650
  });

  it('scales the emailed price by party size and labels the adult count', async () => {
    const db = openDb(':memory:');
    const { sender, sent } = fakeSender();
    const party = { ...settings, adults: 2 };
    await maybeAlert(db, makeDeal(db), party, sender, '2026-06-20 08:00:00');
    expect(sent[0]!.subject).toContain('$1300'); // $650 × 2 adults
    expect(sent[0]!.subject).toContain('for 2 adults');
    expect(sent[0]!.html).toContain('👤 2'); // passenger icon + count above the price
  });

  it('skips a deal above the max price cap (party-size total), sends at/below it', async () => {
    // Deal is $650 at 1 adult. Fresh DB per case so cooldown can't interfere.
    const run = async (alertMaxPriceCents: number) => {
      const db = openDb(':memory:');
      const { sender } = fakeSender();
      return maybeAlert(db, makeDeal(db), { ...settings, alertMaxPriceCents }, sender, '2026-06-20 08:00:00');
    };
    expect((await run(600_00)).reason).toBe('above_max_price'); // $650 > $600 cap
    expect((await run(650_00)).sent).toBe(true); // exactly at the cap
    expect((await run(700_00)).sent).toBe(true);
    expect((await run(0)).sent).toBe(true); // 0 = no cap
  });

  it('applies the max price cap to the party-size total, not the 1-adult price', async () => {
    const db = openDb(':memory:');
    const { sender } = fakeSender();
    // $650 × 2 adults = $1300 total; a $1000 cap must block it.
    const party = { ...settings, adults: 2, alertMaxPriceCents: 1000_00 };
    expect((await maybeAlert(db, makeDeal(db), party, sender, '2026-06-20 08:00:00')).reason).toBe(
      'above_max_price',
    );
    const roomy = { ...settings, adults: 2, alertMaxPriceCents: 1500_00 };
    expect((await maybeAlert(db, makeDeal(db), roomy, sender, '2026-06-20 09:00:00')).sent).toBe(true);
  });

  it('skips a deal whose primary airline the user hid', async () => {
    // Give the combo a fare with a carrier so the deal picks up an airline; the
    // primary of "Delta and KLM" is "Delta".
    const seedCarrier = (db: ReturnType<typeof openDb>, carrier: string) =>
      insertSnapshot(db, {
        source: 'mock',
        origin: 'ABQ',
        destination: 'NAP',
        city: '',
        country: '',
        cabin: 'economy',
        tripType: 'one_week',
        travelMonth: '2026-08',
        departDate: '2026-08-18',
        returnDate: '2026-08-26',
        priceCents: 65000,
        stops: 1,
        carrier,
        capturedAt: '2026-06-20 08:00:00',
      });

    const hidden = openDb(':memory:');
    seedCarrier(hidden, 'Delta and KLM');
    const blocked = await maybeAlert(
      hidden,
      makeDeal(hidden),
      { ...settings, hiddenAirlines: ['Delta'] },
      fakeSender().sender,
      '2026-06-20 08:00:00',
    );
    expect(blocked).toEqual({ sent: false, reason: 'airline_hidden' });

    // Hiding a different airline leaves this Delta deal alone.
    const allowed = openDb(':memory:');
    seedCarrier(allowed, 'Delta and KLM');
    const sent = await maybeAlert(
      allowed,
      makeDeal(allowed),
      { ...settings, hiddenAirlines: ['United'] },
      fakeSender().sender,
      '2026-06-20 08:00:00',
    );
    expect(sent.sent).toBe(true);
  });

  it('names the primary airline in the subject and body', async () => {
    const db = openDb(':memory:');
    insertSnapshot(db, {
      source: 'mock', origin: 'ABQ', destination: 'NAP', city: 'Naples', country: 'Italy',
      cabin: 'economy', tripType: 'one_week', travelMonth: '2026-08',
      departDate: '2026-08-18', returnDate: '2026-08-26',
      priceCents: 65000, stops: 1, carrier: 'Delta and KLM',
      capturedAt: '2026-06-20 08:00:00',
    });
    const { sender, sent } = fakeSender();
    await maybeAlert(db, makeDeal(db, { city: 'Naples', country: 'Italy' }), settings, sender, '2026-06-20 08:00:00');
    expect(sent[0]!.subject).toContain('on Delta'); // primary carrier of "Delta and KLM"
    expect(sent[0]!.html).toContain('Delta');
  });

  it('sends to every recipient when alertEmail lists several', async () => {
    const db = openDb(':memory:');
    const { sender, sent } = fakeSender();
    const multi = { ...settings, alertEmail: 'me@example.com, partner@example.com' };
    const result = await maybeAlert(db, makeDeal(db), multi, sender, '2026-06-20 08:00:00');
    expect(result.sent).toBe(true);
    expect(sent[0]!.to).toEqual(['me@example.com', 'partner@example.com']);
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

  it('honors custom alertMinDiscount and alertCooldownDays from settings', async () => {
    const db = openDb(':memory:');
    const { sender, sent } = fakeSender();
    // A 15% discount fails the default 20% floor but passes a 10% floor.
    const shallow = makeDeal(db, { score: 90, bestPriceCents: 85000, discountPct: 0.15 });
    const lenient = { ...settings, alertMinDiscount: 0.1, alertCooldownDays: 2 };
    const first = await maybeAlert(db, shallow, lenient, sender, '2026-06-20 08:00:00');
    expect(first.sent).toBe(true);

    // Day 21 is inside the default 7-day cooldown but past the custom 2-day one.
    const again = await maybeAlert(db, shallow, lenient, sender, '2026-06-21 08:00:00');
    expect(again).toEqual({ sent: false, reason: 'cooldown' });
    const afterShortCooldown = await maybeAlert(db, shallow, lenient, sender, '2026-06-22 09:00:00');
    expect(afterShortCooldown.sent).toBe(true);
    expect(sent).toHaveLength(2);
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

  it('writes activity-log events for sends and send failures', async () => {
    const db = openDb(':memory:');
    const failing: EmailSender = {
      name: 'console',
      send: async () => {
        throw new Error('boom');
      },
    };
    const deal = makeDeal(db);
    await maybeAlert(db, deal, settings, failing, '2026-06-20 08:00:00');
    const { sender } = fakeSender();
    await maybeAlert(db, deal, settings, sender, '2026-06-20 12:00:00');

    const events = recentEvents(db, 10);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ level: 'info', scope: 'alert' });
    // Destinations aren't seeded in this test DB, so the city falls back to the IATA code.
    expect(events[0]!.message).toContain('alert emailed: NAP Aug 2026 Economy $650');
    expect(events[0]!.message).toContain('→ me@example.com');
    expect(events[1]).toMatchObject({ level: 'error', scope: 'alert' });
    expect(events[1]!.message).toContain('boom');
    expect(events[1]!.detail).toContain('boom');
  });
});
