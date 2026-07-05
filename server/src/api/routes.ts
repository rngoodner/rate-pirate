import { Hono } from 'hono';
import { z } from 'zod';
import {
  googleFlightsUrl,
  type Deal,
  type DealDetail,
  type ScanStatus,
} from '@rate-pirate/shared';
import type { AppDeps } from '../app.js';
import {
  activeDealsWithPlace,
  activeDestinations,
  apiCallsToday,
  getDealWithPlace,
  lastApiCallAt,
  recentDateOptions,
  routeMonthsWithBaseline,
  type DealWithPlace,
} from '../db/repo.js';
import { getSettings, updateSettings } from '../db/settings.js';
import { runScanBatch, HORIZON_MONTHS } from '../scanner/scan.js';
import { alertHtml, alertSubject } from '../alerts/template.js';

const settingsPatchSchema = z
  .object({
    homeAirport: z.string().regex(/^[A-Za-z]{3}$/, 'IATA code must be 3 letters'),
    alertEmail: z.string().email().or(z.literal('')),
    alertThreshold: z.number().int().min(50).max(100),
    dailyCallBudget: z.number().int().min(4).max(5000),
    scanEnabled: z.boolean(),
  })
  .partial()
  .strict();

function toWireDeal(d: DealWithPlace): Deal {
  return {
    id: d.id,
    origin: d.origin,
    destination: d.destination,
    city: d.city,
    country: d.country,
    travelMonth: d.travelMonth,
    bestPriceCents: d.bestPriceCents,
    baselinePriceCents: d.baselinePriceCents,
    discountPct: d.discountPct,
    score: d.score,
    departDate: d.departDate,
    returnDate: d.returnDate,
    firstSeenAt: d.firstSeenAt,
    lastSeenAt: d.lastSeenAt,
    status: d.status,
  };
}

export function apiRoutes(deps: AppDeps): Hono {
  const api = new Hono();
  const { db, config } = deps;

  api.get('/health', (c) => c.json({ ok: true }));

  api.get('/deals', (c) => {
    const deals: Deal[] = activeDealsWithPlace(db, deps.provider.name).map(toWireDeal);
    return c.json(deals);
  });

  api.get('/deals/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    const deal = getDealWithPlace(db, id);
    if (!deal) return c.json({ error: 'deal not found' }, 404);

    const options = recentDateOptions(db, deal.source, deal.origin, deal.destination, 7, 20);
    const detail: DealDetail = {
      ...toWireDeal(deal),
      dateOptions: options.map((o) => ({
        ...o,
        nights: Math.round((Date.parse(o.returnDate) - Date.parse(o.departDate)) / 86_400_000),
        baselinePriceCents: deal.baselinePriceCents,
        googleFlightsUrl: googleFlightsUrl(deal.origin, deal.destination, o.departDate, o.returnDate),
      })),
    };
    return c.json(detail);
  });

  api.get('/settings', (c) => c.json(getSettings(db, config)));

  api.put('/settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = settingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid settings', issues: parsed.error.issues }, 400);
    }
    updateSettings(db, parsed.data);
    return c.json(getSettings(db, config));
  });

  api.get('/status', (c) => {
    const settings = getSettings(db, config);
    const universe = activeDestinations(db).length * HORIZON_MONTHS;
    const status: ScanStatus = {
      provider: deps.provider.name,
      lastScanAt: lastApiCallAt(db, deps.provider.name),
      callsToday: apiCallsToday(db, deps.provider.name),
      dailyCallBudget: settings.dailyCallBudget,
      baselineCoverage:
        universe === 0
          ? 0
          : routeMonthsWithBaseline(db, deps.provider.name, settings.homeAirport) / universe,
      activeDeals: activeDealsWithPlace(db, deps.provider.name).length,
    };
    return c.json(status);
  });

  api.post('/scan', async (c) => c.json(await runScanBatch(deps)));

  api.post('/test-email', async (c) => {
    const sender = deps.sender;
    if (!sender) return c.json({ error: 'no email sender configured' }, 503);
    const settings = getSettings(db, config);
    if (!settings.alertEmail) return c.json({ error: 'no alert email configured' }, 400);
    const sample = {
      origin: settings.homeAirport,
      destination: 'NAP',
      city: 'Naples',
      country: 'Italy',
      travelMonth: '2026-08',
      priceCents: 75800,
      baselineCents: 112300,
      discountPct: 0.33,
      score: 93,
      departDate: '2026-08-18',
      returnDate: '2026-08-26',
    };
    try {
      await sender.send({
        to: settings.alertEmail,
        subject: `[test] ${alertSubject(sample)}`,
        html: alertHtml(sample),
      });
      return c.json({ sent: true, via: sender.name, to: settings.alertEmail });
    } catch (err) {
      return c.json({ sent: false, error: String(err) }, 502);
    }
  });

  return api;
}
