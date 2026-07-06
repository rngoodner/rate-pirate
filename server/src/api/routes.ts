import { Hono } from 'hono';
import { z } from 'zod';
import {
  CABINS,
  googleFlightsUrl,
  isEmail,
  parseRecipients,
  type Deal,
  type DealDetail,
  type ScanStatus,
} from '@rate-pirate/shared';
import type { AppDeps } from '../app.js';
import {
  activeDealsWithPlace,
  activeDestinations,
  apiCallsToday,
  errorsToday,
  getDealWithPlace,
  lastApiCallAt,
  recentDateOptions,
  recentEvents,
  routeMonthsWithBaseline,
  type DealWithPlace,
} from '../db/repo.js';
import { getSettings, updateSettings } from '../db/settings.js';
import { runScanBatch } from '../scanner/scan.js';
import { alertHtml, alertSubject } from '../alerts/template.js';

const settingsPatchSchema = z
  .object({
    homeAirport: z.string().regex(/^[A-Za-z]{3}$/, 'IATA code must be 3 letters'),
    // One or more addresses (comma/space separated); empty is allowed (no alerts).
    alertEmail: z
      .string()
      .refine((s) => parseRecipients(s).every(isEmail), 'each recipient must be a valid email'),
    alertThreshold: z.number().int().min(50).max(100),
    dailyCallBudget: z.number().int().min(4).max(5000),
    scanEnabled: z.boolean(),
    monitoredCabins: z
      .array(z.enum(CABINS))
      .nonempty('select at least one cabin')
      .transform((cabins) => [...new Set(cabins)]),
    alertMinDiscount: z.number().min(0.05).max(0.5),
    alertCooldownDays: z.number().int().min(1).max(30),
    scanHorizonMonths: z.number().int().min(2).max(9),
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
    cabin: d.cabin,
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
    const { monitoredCabins } = getSettings(db, config);
    const deals: Deal[] = activeDealsWithPlace(db, deps.provider.name, monitoredCabins).map(
      toWireDeal,
    );
    return c.json(deals);
  });

  api.get('/deals/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    const deal = getDealWithPlace(db, id);
    if (!deal) return c.json({ error: 'deal not found' }, 404);

    const options = recentDateOptions(
      db,
      deal.source,
      deal.origin,
      deal.destination,
      deal.cabin,
      7,
      20,
    );
    const detail: DealDetail = {
      ...toWireDeal(deal),
      dateOptions: options.map((o) => ({
        ...o,
        nights: Math.round((Date.parse(o.returnDate) - Date.parse(o.departDate)) / 86_400_000),
        baselinePriceCents: deal.baselinePriceCents,
        googleFlightsUrl: googleFlightsUrl(
          deal.origin,
          deal.destination,
          o.departDate,
          o.returnDate,
          deal.cabin,
        ),
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
    // Universe scales with the number of cabins actually monitored.
    const universe =
      activeDestinations(db).length * settings.scanHorizonMonths * settings.monitoredCabins.length;
    const errors = errorsToday(db);
    const calls = apiCallsToday(db, deps.provider.name);
    // "Effectively broken": many failures relative to today's call volume, or
    // repeated batch-level errors (crashes / the zero-price anomaly, which
    // logs once per batch and would never clear a share-of-calls bar).
    const scansBroken =
      (errors >= 5 && errors >= 0.3 * Math.max(calls, 1)) || errorsToday(db, 'batch') >= 2;
    const status: ScanStatus = {
      provider: deps.provider.name,
      lastScanAt: lastApiCallAt(db, deps.provider.name),
      callsToday: calls,
      dailyCallBudget: settings.dailyCallBudget,
      // Clamp: history can hold baselines for months beyond a freshly-shrunk
      // horizon, which would push the ratio past 1.
      baselineCoverage:
        universe === 0
          ? 0
          : Math.min(
              1,
              routeMonthsWithBaseline(db, deps.provider.name, settings.homeAirport, settings.monitoredCabins) /
                universe,
            ),
      activeDeals: activeDealsWithPlace(db, deps.provider.name, settings.monitoredCabins).length,
      errorsToday: errors,
      scansBroken,
    };
    return c.json(status);
  });

  api.get('/events', (c) => c.json(recentEvents(db, 50)));

  api.post('/scan', async (c) => c.json(await runScanBatch(deps)));

  api.post('/test-email', async (c) => {
    const sender = deps.sender;
    if (!sender) return c.json({ error: 'no email sender configured' }, 503);
    const settings = getSettings(db, config);
    const recipients = parseRecipients(settings.alertEmail);
    if (recipients.length === 0) return c.json({ error: 'no alert email configured' }, 400);
    const sample = {
      origin: settings.homeAirport,
      destination: 'NAP',
      city: 'Naples',
      country: 'Italy',
      cabin: settings.monitoredCabins[0] ?? 'economy',
      travelMonth: '2026-08',
      priceCents: 75800,
      baselineCents: 112300,
      discountPct: 0.33,
      score: 93,
      departDate: '2026-08-18',
      returnDate: '2026-08-26',
    };
    // Stamp each test with the current time so repeats aren't byte-identical —
    // otherwise mail providers thread/dedupe/spam-filter the copies and only the
    // first one visibly lands. Real alerts are naturally unique, so this is
    // test-only.
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const html = alertHtml(sample).replace(
      '</body>',
      `<p style="text-align:center;color:#9ca3af;font-size:12px">Test sent ${stamp} UTC</p></body>`,
    );
    try {
      await sender.send({
        to: recipients,
        subject: `[test ${stamp}] ${alertSubject(sample)}`,
        html,
      });
      return c.json({ sent: true, via: sender.name, to: recipients.join(', ') });
    } catch (err) {
      return c.json({ sent: false, error: String(err) }, 502);
    }
  });

  return api;
}
