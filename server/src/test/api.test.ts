import { describe, expect, it } from 'vitest';
import type { Deal, DealDetail, ScanStatus, Settings } from '@rate-pirate/shared';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/db.js';
import { insertSnapshot, seedDestinations, upsertDeal } from '../db/repo.js';
import { DESTINATION_CATALOG } from '../scanner/destinations.js';
import { SyntheticProvider } from '../providers/mock.js';

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
    for (const [depart, ret, price] of [
      ['2099-08-18', '2099-08-26', 65000],
      ['2099-08-04', '2099-08-11', 88000],
    ] as const) {
      insertSnapshot(db, {
        origin: 'ABQ',
        destination: 'NAP',
        cabin: 'economy',
        travelMonth: '2099-08',
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

  it('GET /api/status reports provider, budget, and coverage', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/status');
    const status = (await res.json()) as ScanStatus;
    expect(status.provider).toBe('mock');
    expect(status.dailyCallBudget).toBe(100);
    expect(status.callsToday).toBe(0);
    expect(status.baselineCoverage).toBe(0);
    expect(status.activeDeals).toBe(0);
  });

  it('POST /api/test-email 503s without a sender and 400s without a recipient', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/test-email', { method: 'POST' })).status).toBe(503);
  });
});
