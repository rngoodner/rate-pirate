import { Hono } from 'hono';
import { z } from 'zod';
import {
  CABINS,
  TRIP_TYPES,
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
  apiCallsToday,
  clearEvents,
  combosWithBaseline,
  dealFlightDetails,
  errorsToday,
  getDealWithPlace,
  getPriceInsights,
  lastApiCallAt,
  logEvent,
  recentEvents,
  resetDailyBudget,
  type DealWithPlace,
} from '../db/repo.js';
import { getSettings, updateSettings } from '../db/settings.js';
import {
  calendarRef,
  requestUniverseRescan,
  runDealVerification,
  runScanBatch,
  sqliteStamp,
} from '../scanner/scan.js';
import { nextBatchAt } from '../scanner/scheduler.js';
import { reevaluateDeals } from '../deals/detect.js';
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
    tripTypes: z
      .array(z.enum(TRIP_TYPES))
      .nonempty('select at least one trip type')
      .transform((types) => [...new Set(types)]),
    adults: z.number().int().min(1).max(9),
    alertMinDiscount: z.number().min(0.05).max(0.5),
    dealMinDiscount: z.number().min(0.01).max(0.3),
    alertCooldownDays: z.number().int().min(1).max(30),
  })
  .partial()
  .strict();

// Deals are stored at 1 adult (that's where Google's price history lives).
// Party size is a pure display multiplier — fares scale linearly, so the score
// and discount are unchanged; only the shown totals scale.
function toWireDeal(d: DealWithPlace, adults: number): Deal {
  return {
    id: d.id,
    origin: d.origin,
    destination: d.destination,
    city: d.city,
    country: d.country,
    cabin: d.cabin,
    tripType: d.tripType,
    travelMonth: d.travelMonth,
    bestPriceCents: d.bestPriceCents * adults,
    baselinePriceCents: d.baselinePriceCents * adults,
    discountPct: d.discountPct,
    score: d.score,
    departDate: d.departDate,
    returnDate: d.returnDate,
    firstSeenAt: d.firstSeenAt,
    lastSeenAt: d.lastSeenAt,
    status: d.status,
    adults,
  };
}

export function apiRoutes(deps: AppDeps): Hono {
  const api = new Hono();
  const { db, config } = deps;

  api.get('/health', (c) => c.json({ ok: true }));

  api.get('/deals', (c) => {
    const { monitoredCabins, tripTypes, adults } = getSettings(db, config);
    const deals: Deal[] = activeDealsWithPlace(db, deps.provider.name, monitoredCabins, tripTypes).map(
      (d) => toWireDeal(d, adults),
    );
    return c.json(deals);
  });

  api.get('/deals/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    const deal = getDealWithPlace(db, id);
    if (!deal) return c.json({ error: 'deal not found' }, 404);
    const { adults } = getSettings(db, config);

    // The detailed view of THIS one fare: the deal's flight specifics (from the
    // snapshot backing it) plus Google's price history/verdict for the trip.
    const flight = dealFlightDetails(db, deal.source, deal.origin, deal.destination, deal.cabin, deal.tripType);
    const insights = getPriceInsights(
      db,
      deal.source,
      deal.origin,
      deal.destination,
      deal.cabin,
      deal.tripType,
    );
    const detail: DealDetail = {
      ...toWireDeal(deal, adults),
      nights: Math.round((Date.parse(deal.returnDate) - Date.parse(deal.departDate)) / 86_400_000),
      stops: flight?.stops ?? null,
      carrier: flight?.carrier ?? null,
      durationMinutes: flight?.durationMinutes ?? null,
      layovers: flight?.layovers ?? [],
      googleFlightsUrl: googleFlightsUrl(
        deal.origin,
        deal.destination,
        deal.departDate,
        deal.returnDate,
        deal.cabin,
        adults,
      ),
      // Stored 1-adult history scaled to the party size, like the deal's prices.
      priceHistory: (insights?.series ?? []).map((p) => ({ ...p, priceCents: p.priceCents * adults })),
      googleLevel: insights?.level ?? null,
    };
    return c.json(detail);
  });

  api.get('/settings', (c) => c.json(getSettings(db, config)));

  api.put('/settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = settingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      // Join field-level detail into `error` — it's what the UI displays.
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`)
        .join('; ');
      return c.json({ error: `invalid settings — ${detail}`, issues: parsed.error.issues }, 400);
    }
    const before = getSettings(db, config);
    updateSettings(db, parsed.data);
    const after = getSettings(db, config);
    // Party size (adults) is NOT here: prices are stored at 1 adult and the API
    // scales them by party size at display/booking time, so a change takes
    // effect instantly with no rescan or purge.
    // A feed-floor change applies instantly: re-run detection over stored
    // snapshots (no scans, no alerts) instead of waiting a full scan cycle.
    if (after.dealMinDiscount !== before.dealMinDiscount) {
      const cal = calendarRef(new Date());
      const { combos } = reevaluateDeals(
        db,
        deps.provider.name,
        after.homeAirport,
        after.dealMinDiscount,
        {
          currentMonth: cal.toISOString().slice(0, 7),
          today: cal.toISOString().slice(0, 10),
          cabins: after.monitoredCabins,
          tripTypes: after.tripTypes,
        },
        sqliteStamp(new Date()),
      );
      const active = activeDealsWithPlace(
        db,
        deps.provider.name,
        after.monitoredCabins,
        after.tripTypes,
      ).length;
      logEvent(db, {
        level: 'info',
        scope: 'system',
        message: `feed floor changed to ${Math.round(after.dealMinDiscount * 100)}% — re-evaluated ${combos} combos, ${active} active deal${active === 1 ? '' : 's'}`,
      });
    }
    // A change to the scan universe (home airport, cabins, trip types) needs
    // fresh prices that can't be derived from stored data. Kick off a scan in
    // the background so the feed refills in seconds instead of going dark until
    // the next cron batch. (Party size is excluded — it's a display multiplier.)
    // Fire-and-forget; skipped when scanning is off, queued behind an in-flight
    // batch so it can't be dropped by the mutex.
    const universeChanged =
      after.homeAirport !== before.homeAirport ||
      after.monitoredCabins.join(',') !== before.monitoredCabins.join(',') ||
      after.tripTypes.join(',') !== before.tripTypes.join(',');
    if (universeChanged && after.scanEnabled) {
      requestUniverseRescan(deps);
    }
    return c.json(after);
  });

  api.get('/status', (c) => {
    const settings = getSettings(db, config);
    // Universe = one Explore search per (trip type × cabin).
    const universe = settings.tripTypes.length * settings.monitoredCabins.length;
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
              combosWithBaseline(
                db,
                deps.provider.name,
                settings.homeAirport,
                settings.monitoredCabins,
                settings.tripTypes,
              ) / universe,
            ),
      activeDeals: activeDealsWithPlace(
        db,
        deps.provider.name,
        settings.monitoredCabins,
        settings.tripTypes,
      ).length,
      errorsToday: errors,
      scansBroken,
      nextBatchAt: settings.scanEnabled ? sqliteStamp(nextBatchAt()) : null,
    };
    return c.json(status);
  });

  api.get('/events', (c) => c.json(recentEvents(db, 50)));

  // Clearing the log also resets errorsToday/scansBroken (both derive from it),
  // so the feed's red banner clears with it.
  api.delete('/events', (c) => c.json({ cleared: clearEvents(db) }));

  // `?override=true` runs the manual scan even if the daily budget is spent
  // (the user confirmed going over) — Advanced buttons only.
  api.post('/scan', async (c) =>
    c.json(await runScanBatch(deps, undefined, { overrideBudget: c.req.query('override') === 'true' })),
  );

  api.post('/verify-deals', async (c) =>
    c.json(await runDealVerification(deps, { overrideBudget: c.req.query('override') === 'true' })),
  );

  // Admin "reset daily budget": zero today's call count so scanning can resume
  // within the same local day after the budget was spent. Advanced button only.
  api.post('/reset-budget', (c) => {
    const cleared = resetDailyBudget(db, deps.provider.name);
    logEvent(db, {
      level: 'info',
      scope: 'system',
      message: `daily budget reset — cleared ${cleared} of today's calls`,
    });
    return c.json({ cleared, callsToday: apiCallsToday(db, deps.provider.name) });
  });

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
      tripType: settings.tripTypes[0] ?? 'one_week',
      adults: settings.adults,
      travelMonth: '2026-08',
      priceCents: 75800,
      baselineCents: 112300,
      discountPct: 0.33,
      score: 93,
      departDate: '2026-08-18',
      returnDate: '2026-08-26',
      seenAt: sqliteStamp(new Date()),
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
      // Message only — full stacks/SMTP internals stay in the server log.
      console.error('test email failed:', err);
      return c.json({ sent: false, error: err instanceof Error ? err.message : 'send failed' }, 502);
    }
  });

  return api;
}
