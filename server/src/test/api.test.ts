import { describe, expect, it } from 'vitest';
import type { AppEvent, Deal, DealDetail, ScanStatus, Settings } from '@rate-pirate/shared';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/db.js';
import { insertSnapshot, seedDestinations, upsertDeal } from '../db/repo.js';
import { DESTINATION_CATALOG } from '../scanner/destinations.js';
import { SyntheticProvider } from '../providers/mock.js';
import type { FlightPriceProvider } from '../providers/types.js';

function makeApp() {
  const db = openDb(':memory:');
  seedDestinations(db, DESTINATION_CATALOG);
  const config = loadConfig({});
  const provider = new SyntheticProvider({ seed: 1 });
  const app = createApp({ db, config, provider });
  return { app, db };
}

function seedDeal(db: ReturnType<typeof openDb>, destination: string, score: number) {
  return upsertDeal(db, {
    source: 'mock',
    origin: 'ABQ',
    destination,
    cabin: 'economy',
    travelMonth: '2099-08',
    bestPriceCents: 65000,
    baselinePriceCents: 100000,
    discountPct: 0.35,
    score,
    departDate: '2099-08-18',
    returnDate: '2099-08-26',
    seenAt: '2026-06-20 08:00:00',
  });
}

describe('API routes', () => {
  it('GET /api/deals returns active deals sorted by score with place info', async () => {
    const { app, db } = makeApp();
    seedDeal(db, 'NAP', 88);
    seedDeal(db, 'CUN', 95);

    const res = await app.request('/api/deals');
    expect(res.status).toBe(200);
    const deals = (await res.json()) as Deal[];
    expect(deals.map((d) => d.destination)).toEqual(['CUN', 'NAP']);
    expect(deals[1]).toMatchObject({ city: 'Naples', country: 'Italy', score: 88 });
  });

  it('GET /api/deals/:id returns the deal with date options and booking links', async () => {
    const { app, db } = makeApp();
    const deal = seedDeal(db, 'NAP', 92);
    for (const [month, depart, ret, price] of [
      ['2099-08', '2099-08-18', '2099-08-26', 65000],
      ['2099-08', '2099-08-04', '2099-08-11', 88000],
      // Cheaper, but a different travel month — must NOT appear among the
      // date options of a 2099-08 deal.
      ['2099-09', '2099-09-05', '2099-09-12', 40000],
    ] as const) {
      insertSnapshot(db, {
        origin: 'ABQ',
        destination: 'NAP',
        cabin: 'economy',
        travelMonth: month,
        departDate: depart,
        returnDate: ret,
        priceCents: price,
        stops: 1,
        carrier: 'KL',
        source: 'mock',
      });
    }

    const res = await app.request(`/api/deals/${deal.id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as DealDetail;
    expect(detail.city).toBe('Naples');
    expect(detail.dateOptions).toHaveLength(2);
    expect(detail.dateOptions[0]).toMatchObject({ priceCents: 65000, nights: 8 });
    expect(detail.dateOptions[0]!.googleFlightsUrl).toContain('google.com/travel/flights');
    // Daily-minimum history rides along for the sparkline.
    expect(detail.priceHistory.length).toBeGreaterThan(0);
    expect(detail.priceHistory[0]).toMatchObject({ priceCents: expect.any(Number) });
    expect(detail.priceHistorySource).toBe('observed'); // no insights seeded here
    expect(detail.baselineSource).toBe('observed');
    expect(await (await app.request('/api/deals/999')).status).toBe(404);
  });

  it('GET/PUT /api/settings round-trips and validates', async () => {
    const { app } = makeApp();
    const initial = (await (await app.request('/api/settings')).json()) as Settings;
    expect(initial.homeAirport).toBe('ABQ');

    const put = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ homeAirport: 'den', alertThreshold: 90 }),
    });
    expect(put.status).toBe(200);
    const updated = (await put.json()) as Settings;
    expect(updated.homeAirport).toBe('DEN');
    expect(updated.alertThreshold).toBe(90);

    const bad = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ homeAirport: 'TOOLONG' }),
    });
    expect(bad.status).toBe(400);

    const unknownKey = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: 1 }),
    });
    expect(unknownKey.status).toBe(400);
  });

  it('PUT /api/settings accepts advanced tunables and enforces bounds', async () => {
    const { app } = makeApp();
    const ok = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alertMinDiscount: 0.1, alertCooldownDays: 3, scanHorizonMonths: 4 }),
    });
    expect(ok.status).toBe(200);
    const updated = (await ok.json()) as Settings;
    expect(updated.alertMinDiscount).toBe(0.1);
    expect(updated.alertCooldownDays).toBe(3);
    expect(updated.scanHorizonMonths).toBe(4);

    for (const body of [
      { alertMinDiscount: 0.6 },
      { alertCooldownDays: 0 },
      { scanHorizonMonths: 12 },
    ]) {
      const bad = await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(bad.status).toBe(400);
    }
  });

  it('GET /api/events logs batch activity; scan failures raise errorsToday', async () => {
    // Healthy scan: batch summary event, no errors.
    const { app } = makeApp();
    expect((await app.request('/api/scan', { method: 'POST' })).status).toBe(200);
    const events = (await (await app.request('/api/events')).json()) as AppEvent[];
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ level: 'info', scope: 'batch' });
    expect(events[0]!.message).toMatch(/route-months scanned/);
    let status = (await (await app.request('/api/status')).json()) as ScanStatus;
    expect(status.errorsToday).toBe(0);

    // Broken provider: every task fails → error events + errorsToday > 0.
    const db = openDb(':memory:');
    seedDestinations(db, DESTINATION_CATALOG);
    const broken: FlightPriceProvider = {
      name: 'mock',
      monthQuotes: async () => {
        throw new Error('scrape blocked');
      },
    };
    const brokenApp = createApp({ db, config: loadConfig({}), provider: broken });
    await brokenApp.request('/api/scan', { method: 'POST' });
    const errs = ((await (await brokenApp.request('/api/events')).json()) as AppEvent[]).filter(
      (e) => e.level === 'error',
    );
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatchObject({ scope: 'scan' });
    expect(errs[0]!.message).toContain('scrape blocked');
    status = (await (await brokenApp.request('/api/status')).json()) as ScanStatus;
    expect(status.errorsToday).toBe(errs.length);
    // Every task failed → the server judges scanning broken (feed shows red).
    expect(status.scansBroken).toBe(true);

    // Clearing the log resets the error count AND the broken judgment.
    const cleared = (await (
      await brokenApp.request('/api/events', { method: 'DELETE' })
    ).json()) as { cleared: number };
    expect(cleared.cleared).toBeGreaterThan(0);
    expect((await (await brokenApp.request('/api/events')).json()) as AppEvent[]).toHaveLength(0);
    status = (await (await brokenApp.request('/api/status')).json()) as ScanStatus;
    expect(status.errorsToday).toBe(0);
    expect(status.scansBroken).toBe(false);
  });

  it('GET/PUT /api/destinations lists and toggles the scan catalog', async () => {
    const { app } = makeApp();
    const list = (await (await app.request('/api/destinations')).json()) as {
      iata: string;
      active: boolean;
    }[];
    expect(list.length).toBeGreaterThan(50);
    expect(list.every((d) => d.active)).toBe(true);

    const off = await app.request('/api/destinations/NAP', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { active: boolean }).active).toBe(false);

    const missing = await app.request('/api/destinations/XXX', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    expect(missing.status).toBe(404);

    const badBody = await app.request('/api/destinations/NAP', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: 'yes' }),
    });
    expect(badBody.status).toBe(400);
  });

  it('PUT /api/settings 400s carry field-level detail in error', async () => {
    const { app } = makeApp();
    const bad = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanHorizonMonths: 12 }),
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string };
    expect(body.error).toContain('scanHorizonMonths');
  });

  it('GET /api/status reports provider, budget, and coverage', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/status');
    const status = (await res.json()) as ScanStatus;
    expect(status.provider).toBe('mock');
    expect(status.dailyCallBudget).toBe(100);
    expect(status.callsToday).toBe(0);
    expect(status.baselineCoverage).toBe(0);
    expect(status.activeDeals).toBe(0);
    // Scanning is on by default → a concrete next-batch timestamp.
    expect(status.nextBatchAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanEnabled: false }),
    });
    const paused = (await (await app.request('/api/status')).json()) as ScanStatus;
    expect(paused.nextBatchAt).toBeNull();
  });

  it('POST /api/test-email 503s without a sender and 400s without a recipient', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/test-email', { method: 'POST' })).status).toBe(503);
  });
});
