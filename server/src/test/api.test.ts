import { describe, expect, it } from 'vitest';
import type { AppEvent, Deal, DealDetail, ScanStatus, Settings } from '@rate-pirate/shared';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/db.js';
import { insertSnapshot, recordApiCall, upsertDeal, upsertPriceInsights } from '../db/repo.js';
import { SyntheticProvider } from '../providers/mock.js';
import type { FlightPriceProvider } from '../providers/types.js';

function makeApp() {
  const db = openDb(':memory:');
  const config = loadConfig({});
  const provider = new SyntheticProvider({ seed: 1 });
  const app = createApp({ db, config, provider });
  return { app, db };
}

const PLACES: Record<string, [string, string]> = {
  NAP: ['Naples', 'Italy'],
  CUN: ['Cancún', 'Mexico'],
};

function seedDeal(db: ReturnType<typeof openDb>, destination: string, score: number) {
  const [city, country] = PLACES[destination] ?? [destination, ''];
  return upsertDeal(db, {
    source: 'mock',
    origin: 'ABQ',
    destination,
    city,
    country,
    cabin: 'economy',
    tripType: 'one_week',
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

  it('flags a deal as isNew until it survives a later scan', async () => {
    const { app, db } = makeApp();
    seedDeal(db, 'NAP', 88); // debut: first_seen_at == last_seen_at
    const newDeal = ((await (await app.request('/api/deals')).json()) as Deal[])[0]!;
    expect(newDeal.isNew).toBe(true);

    // A later scan re-confirms it → last_seen_at advances past first_seen_at.
    upsertDeal(db, {
      source: 'mock', origin: 'ABQ', destination: 'NAP', city: 'Naples', country: 'Italy',
      cabin: 'economy', tripType: 'one_week', travelMonth: '2099-08',
      bestPriceCents: 64000, baselinePriceCents: 100000, discountPct: 0.36, score: 88,
      departDate: '2099-08-18', returnDate: '2099-08-26', seenAt: '2026-06-21 08:00:00',
    });
    const seen = ((await (await app.request('/api/deals')).json()) as Deal[])[0]!;
    expect(seen.isNew).toBe(false);
  });

  it('flags alertEligible by score, discount, and the max-price cap', async () => {
    const { app, db } = makeApp();
    seedDeal(db, 'NAP', 88); // score 88 ≥ 85, discount 0.35 ≥ 0.2, no cap → eligible
    seedDeal(db, 'CUN', 80); // score 80 < 85 threshold → not eligible
    const find = (deals: Deal[], dst: string) => deals.find((d) => d.destination === dst)!;

    let deals = (await (await app.request('/api/deals')).json()) as Deal[];
    expect(find(deals, 'NAP').alertEligible).toBe(true);
    expect(find(deals, 'CUN').alertEligible).toBe(false);

    // A max-price cap below the deal's party total ($650) disqualifies it.
    await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alertMaxPriceCents: 600_00 }),
    });
    deals = (await (await app.request('/api/deals')).json()) as Deal[];
    expect(find(deals, 'NAP').alertEligible).toBe(false);
  });

  it('exposes each deal’s primary airline and filters the feed + /airlines by the hidden set', async () => {
    const { app, db } = makeApp();
    seedDeal(db, 'NAP', 90);
    seedDeal(db, 'CUN', 88);
    const snap = (destination: string, carrier: string) =>
      insertSnapshot(db, {
        source: 'mock', origin: 'ABQ', destination, city: '', country: '',
        cabin: 'economy', tripType: 'one_week', travelMonth: '2099-08',
        departDate: '2099-08-18', returnDate: '2099-08-26',
        priceCents: 65000, stops: 1, carrier,
      });
    snap('NAP', 'United and Lufthansa'); // primary = United
    snap('CUN', 'Delta');

    // Each deal carries its cheapest fare's primary (marketing) airline.
    let deals = (await (await app.request('/api/deals')).json()) as Deal[];
    expect(Object.fromEntries(deals.map((d) => [d.destination, d.airline]))).toEqual({
      NAP: 'United',
      CUN: 'Delta',
    });

    // The checklist offers the distinct primary carriers, sorted.
    expect(await (await app.request('/api/airlines')).json()).toEqual(['Delta', 'United']);

    // Hiding United drops NAP from the feed but keeps CUN…
    await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hiddenAirlines: ['United'] }),
    });
    deals = (await (await app.request('/api/deals')).json()) as Deal[];
    expect(deals.map((d) => d.destination)).toEqual(['CUN']);
    expect(deals[0]!.alertEligible).toBe(true);

    // …and a hidden airline stays offered so it can be re-enabled later.
    expect(await (await app.request('/api/airlines')).json()).toContain('United');
  });

  it('GET /api/deals/:id returns the single fare with flight detail and a booking link', async () => {
    const { app, db } = makeApp();
    const deal = seedDeal(db, 'NAP', 92);
    for (const [tripType, depart, ret, price, stops, carrier, duration, layovers] of [
      // The deal's fare = the cheapest one-week snapshot (matches seedDeal).
      ['one_week', '2099-08-18', '2099-08-26', 65000, 1, 'United', 965, [{ airport: 'Atlanta', minutes: 211 }]],
      ['one_week', '2099-08-04', '2099-08-11', 88000, 0, 'Delta', 140, []],
      // A different trip type must never inform this fare.
      ['two_weeks', '2099-09-05', '2099-09-19', 40000, 1, 'KL', 1200, [{ airport: 'Paris', minutes: 90 }]],
    ] as const) {
      insertSnapshot(db, {
        origin: 'ABQ',
        destination: 'NAP',
        city: 'Naples',
        country: 'Italy',
        cabin: 'economy',
        tripType,
        travelMonth: depart.slice(0, 7),
        departDate: depart,
        returnDate: ret,
        priceCents: price,
        stops,
        carrier,
        durationMinutes: duration,
        layovers: [...layovers],
        source: 'mock',
      });
    }
    // Google's price history for the trip: its series backs the sparkline and
    // its level is the verdict shown on the page.
    upsertPriceInsights(
      db,
      { source: 'mock', origin: 'ABQ', destination: 'NAP', cabin: 'economy', tripType: 'one_week' },
      {
        level: 'low',
        history: [
          { date: '2026-06-18', priceCents: 90000 },
          { date: '2026-06-19', priceCents: 88000 },
          { date: '2026-06-20', priceCents: 65000 },
        ],
        capturedAt: '2026-06-20 08:00:00',
      },
    );

    const res = await app.request(`/api/deals/${deal.id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as DealDetail;
    expect(detail.city).toBe('Naples');
    // One fare: the deal's own dates/price plus its itinerary's flight specifics
    // (layovers round-trip through the JSON column).
    expect(detail).toMatchObject({
      departDate: '2099-08-18',
      returnDate: '2099-08-26',
      nights: 8,
      bestPriceCents: 65000,
      baselinePriceCents: 100000,
      stops: 1,
      carrier: 'United',
      durationMinutes: 965,
      layovers: [{ airport: 'Atlanta', minutes: 211 }],
    });
    expect(detail.googleFlightsUrl).toContain('google.com/travel/flights');
    // Google's own verdict surfaces on the page.
    expect(detail.googleLevel).toBe('low');
    // The sparkline is Google's price-history series for the trip.
    expect(detail.priceHistory).toEqual([
      { date: '2026-06-18', priceCents: 90000 },
      { date: '2026-06-19', priceCents: 88000 },
      { date: '2026-06-20', priceCents: 65000 },
    ]);
    expect(await (await app.request('/api/deals/999')).status).toBe(404);
  });

  it('scales displayed prices by party size (no rescrape, no purge)', async () => {
    const { app, db } = makeApp();
    seedDeal(db, 'NAP', 90); // stored at 1 adult: best 65000, baseline 100000

    let deals = (await (await app.request('/api/deals')).json()) as Deal[];
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({ bestPriceCents: 65000, baselinePriceCents: 100000 });

    const put = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adults: 3 }),
    });
    expect(put.status).toBe(200);

    // Same deal, still there — prices scaled ×3, score/discount unchanged.
    deals = (await (await app.request('/api/deals')).json()) as Deal[];
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({
      bestPriceCents: 195000,
      baselinePriceCents: 300000,
      score: 90,
    });
    // Deal detail scales its history + booking link too.
    const detail = (await (await app.request(`/api/deals/${deals[0]!.id}`)).json()) as DealDetail;
    expect(detail.bestPriceCents).toBe(195000);
    expect(detail.googleFlightsUrl).toContain('google.com/travel/flights');
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
      body: JSON.stringify({
        alertMinDiscount: 0.1,
        alertCooldownDays: 3,
        tripTypes: ['weekend', 'one_week'],
        adults: 2,
      }),
    });
    expect(ok.status).toBe(200);
    const updated = (await ok.json()) as Settings;
    expect(updated.alertMinDiscount).toBe(0.1);
    expect(updated.alertCooldownDays).toBe(3);
    expect(updated.tripTypes).toEqual(['weekend', 'one_week']);
    expect(updated.adults).toBe(2);

    for (const body of [
      { alertMinDiscount: 0.6 },
      { dealMinDiscount: 0.5 },
      { alertCooldownDays: 0 },
      { adults: 99 },
      { adults: 0 },
      { tripTypes: [] },
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
    expect(events[0]!.message).toMatch(/candidates scored/);
    let status = (await (await app.request('/api/status')).json()) as ScanStatus;
    expect(status.errorsToday).toBe(0);

    // Broken provider: Explore still lists destinations, but every fixed-date
    // fetch fails → error events + errorsToday > 0.
    const db = openDb(':memory:');
    const broken: FlightPriceProvider = {
      name: 'mock',
      exploreSearch: (q) => new SyntheticProvider({ seed: 7 }).exploreSearch(q),
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
    // Every candidate failed → the server judges scanning broken (feed shows red).
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
    expect(status.scanning).toBe(false); // no batch running in a fresh app
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

  it('POST /api/reset-budget zeroes today\'s calls without starting a scan', async () => {
    const { app, db } = makeApp();
    recordApiCall(db, { provider: 'mock', endpoint: 'flights-page', ok: true });
    recordApiCall(db, { provider: 'mock', endpoint: 'flights-page', ok: true });
    const deal = seedDeal(db, 'NAP', 90);

    const before = (await (await app.request('/api/status')).json()) as ScanStatus;
    expect(before.callsToday).toBe(2);

    const res = await app.request('/api/reset-budget', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 2, callsToday: 0 });

    // No scan side effects: budget stays at 0 (a scan would immediately log
    // calls), the existing deal is untouched, and only a 'system' reset event
    // was logged — never a 'scan'/'batch' one.
    const after = (await (await app.request('/api/status')).json()) as ScanStatus;
    expect(after.callsToday).toBe(0);
    expect(after.activeDeals).toBe(before.activeDeals);
    const events = (await (await app.request('/api/events')).json()) as AppEvent[];
    expect(events.some((e) => e.message.includes('daily budget reset'))).toBe(true);
    expect(events.some((e) => e.scope === 'scan' || e.scope === 'batch')).toBe(false);
    expect(deal.status).toBe('active');
  });
});
