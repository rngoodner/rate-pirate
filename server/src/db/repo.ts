import type { Cabin } from '@rate-pirate/shared';
import type { Db } from './db.js';

export interface SnapshotInput {
  origin: string;
  destination: string;
  cabin: Cabin;
  travelMonth: string;
  departDate: string;
  returnDate: string;
  priceCents: number;
  stops: number | null;
  carrier: string | null;
  source: string;
  /** ISO timestamp override for tests/simulator; defaults to now. */
  capturedAt?: string;
}

export interface SnapshotRow extends Required<Omit<SnapshotInput, 'capturedAt'>> {
  id: number;
  capturedAt: string;
}

export interface DestinationRow {
  iata: string;
  city: string;
  country: string;
  region: string;
  tier: number;
  active: boolean;
}

const snapshotCols = `id, origin, destination, cabin, travel_month AS travelMonth, depart_date AS departDate,
  return_date AS returnDate, price_cents AS priceCents, stops, carrier, source, captured_at AS capturedAt`;

export function insertSnapshot(db: Db, s: SnapshotInput): void {
  db.prepare(
    `INSERT INTO price_snapshots
       (origin, destination, cabin, travel_month, depart_date, return_date, price_cents, stops, carrier, source, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(
    s.origin,
    s.destination,
    s.cabin,
    s.travelMonth,
    s.departDate,
    s.returnDate,
    s.priceCents,
    s.stops,
    s.carrier,
    s.source,
    s.capturedAt ?? null,
  );
}

export function snapshotsForRouteMonth(
  db: Db,
  source: string,
  origin: string,
  destination: string,
  cabin: Cabin,
  travelMonth: string,
  sinceDays: number,
  asOf?: string,
): SnapshotRow[] {
  return db
    .prepare(
      `SELECT ${snapshotCols} FROM price_snapshots
       WHERE source = ? AND origin = ? AND destination = ? AND cabin = ? AND travel_month = ?
         AND captured_at >= datetime(COALESCE(?, 'now'), '-' || ? || ' days')
         AND captured_at <= COALESCE(?, datetime('now'))
       ORDER BY captured_at`,
    )
    .all(source, origin, destination, cabin, travelMonth, asOf ?? null, sinceDays, asOf ?? null) as SnapshotRow[];
}

export function snapshotsForRoute(
  db: Db,
  source: string,
  origin: string,
  destination: string,
  cabin: Cabin,
  sinceDays: number,
  asOf?: string,
): SnapshotRow[] {
  return db
    .prepare(
      `SELECT ${snapshotCols} FROM price_snapshots
       WHERE source = ? AND origin = ? AND destination = ? AND cabin = ?
         AND captured_at >= datetime(COALESCE(?, 'now'), '-' || ? || ' days')
         AND captured_at <= COALESCE(?, datetime('now'))
       ORDER BY captured_at`,
    )
    .all(source, origin, destination, cabin, asOf ?? null, sinceDays, asOf ?? null) as SnapshotRow[];
}

/** Latest capture time per route-month-cabin, for the planner's staleness
 *  ranking. Keys are `${destination}|${month}|${cabin}`. */
export function latestCaptureByRouteMonth(
  db: Db,
  source: string,
  origin: string,
): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT destination, cabin, travel_month AS travelMonth, MAX(captured_at) AS latest
       FROM price_snapshots WHERE source = ? AND origin = ?
       GROUP BY destination, cabin, travel_month`,
    )
    .all(source, origin) as {
    destination: string;
    cabin: string;
    travelMonth: string;
    latest: string;
  }[];
  return new Map(rows.map((r) => [`${r.destination}|${r.travelMonth}|${r.cabin}`, r.latest]));
}

export function pruneSnapshots(db: Db, olderThanDays: number): number {
  return db
    .prepare(`DELETE FROM price_snapshots WHERE captured_at < datetime('now', '-' || ? || ' days')`)
    .run(olderThanDays).changes;
}

// --- destinations ---

export function seedDestinations(
  db: Db,
  catalog: Omit<DestinationRow, 'active'>[],
): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO destinations (iata, city, country, region, tier) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (const d of catalog) insert.run(d.iata, d.city, d.country, d.region, d.tier);
  })();
}

export function activeDestinations(db: Db): DestinationRow[] {
  return (
    db
      .prepare('SELECT iata, city, country, region, tier, active FROM destinations WHERE active = 1')
      .all() as (Omit<DestinationRow, 'active'> & { active: number })[]
  ).map((r) => ({ ...r, active: r.active === 1 }));
}

export function allDestinations(db: Db): DestinationRow[] {
  return (
    db
      .prepare(
        'SELECT iata, city, country, region, tier, active FROM destinations ORDER BY city',
      )
      .all() as (Omit<DestinationRow, 'active'> & { active: number })[]
  ).map((r) => ({ ...r, active: r.active === 1 }));
}

export function setDestinationActive(db: Db, iata: string, active: boolean): boolean {
  return (
    db.prepare('UPDATE destinations SET active = ? WHERE iata = ?').run(active ? 1 : 0, iata)
      .changes > 0
  );
}

export function getDestination(db: Db, iata: string): DestinationRow | null {
  const r = db
    .prepare('SELECT iata, city, country, region, tier, active FROM destinations WHERE iata = ?')
    .get(iata) as (Omit<DestinationRow, 'active'> & { active: number }) | undefined;
  return r ? { ...r, active: r.active === 1 } : null;
}

/** Snapshots from the most recent scan of a route-month (all share captured_at). */
export function latestScanSnapshots(
  db: Db,
  source: string,
  origin: string,
  destination: string,
  cabin: Cabin,
  travelMonth: string,
  asOf?: string,
): SnapshotRow[] {
  return db
    .prepare(
      `SELECT ${snapshotCols} FROM price_snapshots
       WHERE source = ? AND origin = ? AND destination = ? AND cabin = ? AND travel_month = ?
         AND captured_at = (
           SELECT MAX(captured_at) FROM price_snapshots
           WHERE source = ? AND origin = ? AND destination = ? AND cabin = ? AND travel_month = ?
             AND captured_at <= COALESCE(?, datetime('now'))
         )
       ORDER BY price_cents`,
    )
    .all(
      source,
      origin,
      destination,
      cabin,
      travelMonth,
      source,
      origin,
      destination,
      cabin,
      travelMonth,
      asOf ?? null,
    ) as SnapshotRow[];
}

// --- deals ---

export interface DealRow {
  id: number;
  source: string;
  origin: string;
  destination: string;
  cabin: Cabin;
  travelMonth: string;
  bestPriceCents: number;
  baselinePriceCents: number;
  discountPct: number;
  score: number;
  departDate: string;
  returnDate: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status: 'active' | 'expired';
}

const dealCols = `id, source, origin, destination, cabin, travel_month AS travelMonth,
  best_price_cents AS bestPriceCents, baseline_price_cents AS baselinePriceCents,
  discount_pct AS discountPct, score, depart_date AS departDate, return_date AS returnDate,
  first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, status`;

export interface DealInput {
  source: string;
  origin: string;
  destination: string;
  cabin: Cabin;
  travelMonth: string;
  bestPriceCents: number;
  baselinePriceCents: number;
  discountPct: number;
  score: number;
  departDate: string;
  returnDate: string;
  seenAt: string;
}

export function upsertDeal(db: Db, d: DealInput): DealRow {
  db.prepare(
    `INSERT INTO deals (source, origin, destination, cabin, travel_month, best_price_cents, baseline_price_cents,
       discount_pct, score, depart_date, return_date, first_seen_at, last_seen_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(source, origin, destination, cabin, travel_month) DO UPDATE SET
       best_price_cents = excluded.best_price_cents,
       baseline_price_cents = excluded.baseline_price_cents,
       discount_pct = excluded.discount_pct,
       score = excluded.score,
       depart_date = excluded.depart_date,
       return_date = excluded.return_date,
       last_seen_at = excluded.last_seen_at,
       -- A deal re-emerging after expiry (price recovered, then dropped again)
       -- is a new episode: restart its first-seen clock.
       first_seen_at = CASE WHEN deals.status = 'expired'
                            THEN excluded.first_seen_at ELSE deals.first_seen_at END,
       status = 'active'`,
  ).run(
    d.source,
    d.origin,
    d.destination,
    d.cabin,
    d.travelMonth,
    d.bestPriceCents,
    d.baselinePriceCents,
    d.discountPct,
    d.score,
    d.departDate,
    d.returnDate,
    d.seenAt,
    d.seenAt,
  );
  return getDealByRouteMonth(db, d.source, d.origin, d.destination, d.cabin, d.travelMonth)!;
}

export function getDealByRouteMonth(
  db: Db,
  source: string,
  origin: string,
  destination: string,
  cabin: Cabin,
  travelMonth: string,
): DealRow | null {
  return (
    (db
      .prepare(
        `SELECT ${dealCols} FROM deals
         WHERE source = ? AND origin = ? AND destination = ? AND cabin = ? AND travel_month = ?`,
      )
      .get(source, origin, destination, cabin, travelMonth) as DealRow | undefined) ?? null
  );
}

export function getDeal(db: Db, id: number): DealRow | null {
  return (
    (db.prepare(`SELECT ${dealCols} FROM deals WHERE id = ?`).get(id) as DealRow | undefined) ??
    null
  );
}

export function activeDeals(db: Db, source: string): DealRow[] {
  return db
    .prepare(
      `SELECT ${dealCols} FROM deals WHERE source = ? AND status = 'active'
       ORDER BY score DESC, discount_pct DESC`,
    )
    .all(source) as DealRow[];
}

export function expireDeal(db: Db, id: number): void {
  db.prepare(`UPDATE deals SET status = 'expired' WHERE id = ?`).run(id);
}

/** Expire deals whose travel month has passed. */
export function expireDealsBeforeMonth(db: Db, month: string): number {
  return db
    .prepare(`UPDATE deals SET status = 'expired' WHERE status = 'active' AND travel_month < ?`)
    .run(month).changes;
}

/** Expire active deals the scanner will never re-evaluate: wrong origin (home
 *  airport changed), travel month beyond the horizon (horizon shrunk), a
 *  departure date already in the past, or a destination the user deactivated.
 *  Without this, such "zombie" deals sit in the feed showing stale prices
 *  indefinitely. Unmonitored cabins are NOT expired — the feed already hides
 *  them, and expiring would break the toggle-a-cabin-to-peek flow (and demo
 *  mode's instant cabin switching). */
export function expireDealsOutsideUniverse(
  db: Db,
  opts: { source: string; origin: string; lastMonth: string; today: string },
): number {
  return db
    .prepare(
      `UPDATE deals SET status = 'expired'
       WHERE status = 'active' AND source = ?
         AND (origin != ? OR travel_month > ? OR depart_date < ?
           OR destination IN (SELECT iata FROM destinations WHERE active = 0))`,
    )
    .run(opts.source, opts.origin, opts.lastMonth, opts.today).changes;
}

/** Daily-minimum price series for one route-month-cabin — the deal page's
 *  sparkline. Same daily-minima basis as the baseline computation. */
export function dailyMinimaSeries(
  db: Db,
  source: string,
  origin: string,
  destination: string,
  cabin: Cabin,
  travelMonth: string,
  days: number,
): { date: string; priceCents: number }[] {
  return db
    .prepare(
      `SELECT date(captured_at) AS date, MIN(price_cents) AS priceCents
       FROM price_snapshots
       WHERE source = ? AND origin = ? AND destination = ? AND cabin = ? AND travel_month = ?
         AND captured_at >= datetime('now', '-' || ? || ' days')
       GROUP BY date(captured_at) ORDER BY date`,
    )
    .all(source, origin, destination, cabin, travelMonth, days) as {
    date: string;
    priceCents: number;
  }[];
}

export interface DealWithPlace extends DealRow {
  city: string;
  country: string;
}

const dealPlaceCols = `d.id, d.source, d.origin, d.destination, d.cabin, d.travel_month AS travelMonth,
  d.best_price_cents AS bestPriceCents, d.baseline_price_cents AS baselinePriceCents,
  d.discount_pct AS discountPct, d.score, d.depart_date AS departDate,
  d.return_date AS returnDate, d.first_seen_at AS firstSeenAt,
  d.last_seen_at AS lastSeenAt, d.status`;

/** Active deals for the given source, restricted to the given cabins (the feed
 *  only shows cabins the user currently monitors). Empty `cabins` → no deals. */
export function activeDealsWithPlace(db: Db, source: string, cabins: Cabin[]): DealWithPlace[] {
  if (cabins.length === 0) return [];
  const placeholders = cabins.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT ${dealPlaceCols}, COALESCE(dest.city, d.destination) AS city,
              COALESCE(dest.country, '') AS country
       FROM deals d LEFT JOIN destinations dest ON dest.iata = d.destination
       WHERE d.source = ? AND d.status = 'active' AND d.cabin IN (${placeholders})
       ORDER BY d.score DESC, d.discount_pct DESC`,
    )
    .all(source, ...cabins) as DealWithPlace[];
}

export function getDealWithPlace(db: Db, id: number): DealWithPlace | null {
  return (
    (db
      .prepare(
        `SELECT ${dealPlaceCols}, COALESCE(dest.city, d.destination) AS city,
                COALESCE(dest.country, '') AS country
         FROM deals d LEFT JOIN destinations dest ON dest.iata = d.destination
         WHERE d.id = ?`,
      )
      .get(id) as DealWithPlace | undefined) ?? null
  );
}

/** Most recent price per distinct date pair on a route+cabin, cheapest first. */
export function recentDateOptions(
  db: Db,
  source: string,
  origin: string,
  destination: string,
  cabin: Cabin,
  sinceDays: number,
  limit: number,
): { departDate: string; returnDate: string; priceCents: number; capturedAt: string }[] {
  return db
    .prepare(
      `SELECT depart_date AS departDate, return_date AS returnDate,
              price_cents AS priceCents, captured_at AS capturedAt
       FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY depart_date, return_date ORDER BY captured_at DESC
         ) AS rn
         FROM price_snapshots
         WHERE source = ? AND origin = ? AND destination = ? AND cabin = ?
           AND captured_at >= datetime('now', '-' || ? || ' days')
           AND depart_date >= date('now', 'localtime')
       )
       WHERE rn = 1 ORDER BY price_cents LIMIT ?`,
    )
    .all(source, origin, destination, cabin, sinceDays, limit) as {
    departDate: string;
    returnDate: string;
    priceCents: number;
    capturedAt: string;
  }[];
}

/** Route-month-cabins whose recent history is deep enough for a baseline,
 *  restricted to the given cabins. */
export function routeMonthsWithBaseline(
  db: Db,
  source: string,
  origin: string,
  cabins: Cabin[],
): number {
  if (cabins.length === 0) return 0;
  const placeholders = cabins.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT destination, travel_month, cabin FROM price_snapshots
         WHERE source = ? AND origin = ? AND cabin IN (${placeholders})
           AND captured_at >= datetime('now', '-60 days')
         GROUP BY destination, travel_month, cabin
         HAVING COUNT(DISTINCT date(captured_at)) >= 10
       )`,
    )
    .get(source, origin, ...cabins) as { n: number };
  return row.n;
}

// --- alerts ---

export function recordAlert(
  db: Db,
  a: { dealId: number; sentTo: string; priceCents: number; score: number; sentAt?: string },
): void {
  db.prepare(
    `INSERT INTO alerts (deal_id, sent_to, price_cents, score, sent_at)
     VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(a.dealId, a.sentTo, a.priceCents, a.score, a.sentAt ?? null);
}

export function lastAlertForDeal(
  db: Db,
  dealId: number,
): { sentAt: string; priceCents: number } | null {
  return (
    (db
      .prepare(
        `SELECT sent_at AS sentAt, price_cents AS priceCents FROM alerts
         WHERE deal_id = ? ORDER BY sent_at DESC LIMIT 1`,
      )
      .get(dealId) as { sentAt: string; priceCents: number } | undefined) ?? null
  );
}

// --- api call accounting ---

export interface ApiCallInput {
  provider: string;
  endpoint: string;
  route?: string;
  status?: number;
  ok: boolean;
  /** ISO timestamp override for the simulator; defaults to now. */
  calledAt?: string;
}

export function recordApiCall(db: Db, c: ApiCallInput): void {
  db.prepare(
    `INSERT INTO api_calls (provider, endpoint, route, status, ok, called_at)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(c.provider, c.endpoint, c.route ?? null, c.status ?? null, c.ok ? 1 : 0, c.calledAt ?? null);
}

/** Calls made on the current day. The day boundary is the server's LOCAL
 *  midnight (called_at is stored UTC) — with a UTC boundary the counter and
 *  the daily budget would reset at 5–6pm in America/Denver. When `asOf` is
 *  given (simulator virtual clock) timestamps are compared as-is. */
export function apiCallsToday(db: Db, provider: string, asOf?: string): number {
  const row = asOf
    ? (db
        .prepare(
          `SELECT COUNT(*) AS n FROM api_calls
           WHERE provider = ? AND called_at >= date(?) AND called_at <= ?`,
        )
        .get(provider, asOf, asOf) as { n: number })
    : (db
        .prepare(
          `SELECT COUNT(*) AS n FROM api_calls
           WHERE provider = ? AND datetime(called_at, 'localtime') >= date('now', 'localtime')`,
        )
        .get(provider) as { n: number });
  return row.n;
}

export function lastApiCallAt(db: Db, provider: string): string | null {
  const row = db
    .prepare('SELECT MAX(called_at) AS latest FROM api_calls WHERE provider = ? AND ok = 1')
    .get(provider) as { latest: string | null };
  return row.latest;
}

export function pruneApiCalls(db: Db, olderThanDays: number): number {
  return db
    .prepare(`DELETE FROM api_calls WHERE called_at < datetime('now', '-' || ? || ' days')`)
    .run(olderThanDays).changes;
}

// --- App events (in-app activity/error log) ---

export interface AppEventInput {
  level: 'info' | 'error';
  scope: 'scan' | 'batch' | 'alert' | 'system';
  message: string;
  detail?: string;
  /** ISO timestamp override for the simulator; defaults to now. */
  at?: string;
}

export interface AppEventRow {
  id: number;
  level: 'info' | 'error';
  scope: string;
  message: string;
  detail: string | null;
  createdAt: string;
}

const DETAIL_MAX = 2000;

export function logEvent(db: Db, e: AppEventInput): void {
  db.prepare(
    `INSERT INTO app_events (level, scope, message, detail, created_at)
     VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(e.level, e.scope, e.message.slice(0, 300), e.detail?.slice(0, DETAIL_MAX) ?? null, e.at ?? null);
}

export function recentEvents(db: Db, limit: number): AppEventRow[] {
  return db
    .prepare(
      `SELECT id, level, scope, message, detail, created_at AS createdAt
       FROM app_events ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as AppEventRow[];
}

/** Errors logged today, optionally within one scope; LOCAL day boundary, same
 *  rationale as apiCallsToday. */
export function errorsToday(db: Db, scope?: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM app_events
       WHERE level = 'error' AND (? IS NULL OR scope = ?)
         AND datetime(created_at, 'localtime') >= date('now', 'localtime')`,
    )
    .get(scope ?? null, scope ?? null) as { n: number };
  return row.n;
}

export function pruneEvents(db: Db, olderThanDays: number): number {
  return db
    .prepare(`DELETE FROM app_events WHERE created_at < datetime('now', '-' || ? || ' days')`)
    .run(olderThanDays).changes;
}

/** Remove all demo/mock artifacts. Called on boot when a real provider is
 *  active so a demo session never bleeds into live data. */
export function purgeMockData(db: Db): number {
  return db.transaction(() => {
    db.prepare(`DELETE FROM alerts WHERE deal_id IN (SELECT id FROM deals WHERE source = 'mock')`).run();
    const deals = db.prepare(`DELETE FROM deals WHERE source = 'mock'`).run().changes;
    const snaps = db.prepare(`DELETE FROM price_snapshots WHERE source = 'mock'`).run().changes;
    db.prepare(`DELETE FROM api_calls WHERE provider = 'mock'`).run();
    return deals + snaps;
  })();
}
