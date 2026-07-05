import type { Db } from './db.js';

export interface SnapshotInput {
  origin: string;
  destination: string;
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

const snapshotCols = `id, origin, destination, travel_month AS travelMonth, depart_date AS departDate,
  return_date AS returnDate, price_cents AS priceCents, stops, carrier, source, captured_at AS capturedAt`;

export function insertSnapshot(db: Db, s: SnapshotInput): void {
  db.prepare(
    `INSERT INTO price_snapshots
       (origin, destination, travel_month, depart_date, return_date, price_cents, stops, carrier, source, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(
    s.origin,
    s.destination,
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
  origin: string,
  destination: string,
  travelMonth: string,
  sinceDays: number,
  asOf?: string,
): SnapshotRow[] {
  return db
    .prepare(
      `SELECT ${snapshotCols} FROM price_snapshots
       WHERE origin = ? AND destination = ? AND travel_month = ?
         AND captured_at >= datetime(COALESCE(?, 'now'), '-' || ? || ' days')
         AND captured_at <= COALESCE(?, datetime('now'))
       ORDER BY captured_at`,
    )
    .all(origin, destination, travelMonth, asOf ?? null, sinceDays, asOf ?? null) as SnapshotRow[];
}

export function snapshotsForRoute(
  db: Db,
  origin: string,
  destination: string,
  sinceDays: number,
  asOf?: string,
): SnapshotRow[] {
  return db
    .prepare(
      `SELECT ${snapshotCols} FROM price_snapshots
       WHERE origin = ? AND destination = ?
         AND captured_at >= datetime(COALESCE(?, 'now'), '-' || ? || ' days')
         AND captured_at <= COALESCE(?, datetime('now'))
       ORDER BY captured_at`,
    )
    .all(origin, destination, asOf ?? null, sinceDays, asOf ?? null) as SnapshotRow[];
}

/** Latest capture time per route-month, for the planner's staleness ranking. */
export function latestCaptureByRouteMonth(db: Db, origin: string): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT destination, travel_month AS travelMonth, MAX(captured_at) AS latest
       FROM price_snapshots WHERE origin = ? GROUP BY destination, travel_month`,
    )
    .all(origin) as { destination: string; travelMonth: string; latest: string }[];
  return new Map(rows.map((r) => [`${r.destination}|${r.travelMonth}`, r.latest]));
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

export function getDestination(db: Db, iata: string): DestinationRow | null {
  const r = db
    .prepare('SELECT iata, city, country, region, tier, active FROM destinations WHERE iata = ?')
    .get(iata) as (Omit<DestinationRow, 'active'> & { active: number }) | undefined;
  return r ? { ...r, active: r.active === 1 } : null;
}

/** Snapshots from the most recent scan of a route-month (all share captured_at). */
export function latestScanSnapshots(
  db: Db,
  origin: string,
  destination: string,
  travelMonth: string,
  asOf?: string,
): SnapshotRow[] {
  return db
    .prepare(
      `SELECT ${snapshotCols} FROM price_snapshots
       WHERE origin = ? AND destination = ? AND travel_month = ?
         AND captured_at = (
           SELECT MAX(captured_at) FROM price_snapshots
           WHERE origin = ? AND destination = ? AND travel_month = ?
             AND captured_at <= COALESCE(?, datetime('now'))
         )
       ORDER BY price_cents`,
    )
    .all(
      origin,
      destination,
      travelMonth,
      origin,
      destination,
      travelMonth,
      asOf ?? null,
    ) as SnapshotRow[];
}

// --- deals ---

export interface DealRow {
  id: number;
  origin: string;
  destination: string;
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

const dealCols = `id, origin, destination, travel_month AS travelMonth,
  best_price_cents AS bestPriceCents, baseline_price_cents AS baselinePriceCents,
  discount_pct AS discountPct, score, depart_date AS departDate, return_date AS returnDate,
  first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, status`;

export interface DealInput {
  origin: string;
  destination: string;
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
    `INSERT INTO deals (origin, destination, travel_month, best_price_cents, baseline_price_cents,
       discount_pct, score, depart_date, return_date, first_seen_at, last_seen_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(origin, destination, travel_month) DO UPDATE SET
       best_price_cents = excluded.best_price_cents,
       baseline_price_cents = excluded.baseline_price_cents,
       discount_pct = excluded.discount_pct,
       score = excluded.score,
       depart_date = excluded.depart_date,
       return_date = excluded.return_date,
       last_seen_at = excluded.last_seen_at,
       status = 'active'`,
  ).run(
    d.origin,
    d.destination,
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
  return getDealByRouteMonth(db, d.origin, d.destination, d.travelMonth)!;
}

export function getDealByRouteMonth(
  db: Db,
  origin: string,
  destination: string,
  travelMonth: string,
): DealRow | null {
  return (
    (db
      .prepare(
        `SELECT ${dealCols} FROM deals WHERE origin = ? AND destination = ? AND travel_month = ?`,
      )
      .get(origin, destination, travelMonth) as DealRow | undefined) ?? null
  );
}

export function getDeal(db: Db, id: number): DealRow | null {
  return (
    (db.prepare(`SELECT ${dealCols} FROM deals WHERE id = ?`).get(id) as DealRow | undefined) ??
    null
  );
}

export function activeDeals(db: Db): DealRow[] {
  return db
    .prepare(`SELECT ${dealCols} FROM deals WHERE status = 'active' ORDER BY score DESC, discount_pct DESC`)
    .all() as DealRow[];
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

export interface DealWithPlace extends DealRow {
  city: string;
  country: string;
}

const dealPlaceCols = `d.id, d.origin, d.destination, d.travel_month AS travelMonth,
  d.best_price_cents AS bestPriceCents, d.baseline_price_cents AS baselinePriceCents,
  d.discount_pct AS discountPct, d.score, d.depart_date AS departDate,
  d.return_date AS returnDate, d.first_seen_at AS firstSeenAt,
  d.last_seen_at AS lastSeenAt, d.status`;

export function activeDealsWithPlace(db: Db): DealWithPlace[] {
  return db
    .prepare(
      `SELECT ${dealPlaceCols}, COALESCE(dest.city, d.destination) AS city,
              COALESCE(dest.country, '') AS country
       FROM deals d LEFT JOIN destinations dest ON dest.iata = d.destination
       WHERE d.status = 'active'
       ORDER BY d.score DESC, d.discount_pct DESC`,
    )
    .all() as DealWithPlace[];
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

/** Most recent price per distinct date pair on a route, cheapest first. */
export function recentDateOptions(
  db: Db,
  origin: string,
  destination: string,
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
         WHERE origin = ? AND destination = ?
           AND captured_at >= datetime('now', '-' || ? || ' days')
           AND depart_date >= date('now')
       )
       WHERE rn = 1 ORDER BY price_cents LIMIT ?`,
    )
    .all(origin, destination, sinceDays, limit) as {
    departDate: string;
    returnDate: string;
    priceCents: number;
    capturedAt: string;
  }[];
}

/** Route-months whose recent history is deep enough for a month baseline. */
export function routeMonthsWithBaseline(db: Db, origin: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT destination, travel_month FROM price_snapshots
         WHERE origin = ? AND captured_at >= datetime('now', '-60 days')
         GROUP BY destination, travel_month
         HAVING COUNT(DISTINCT date(captured_at)) >= 10
       )`,
    )
    .get(origin) as { n: number };
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

/** Calls made on the (virtual) current day; day boundary from SQLite's date(). */
export function apiCallsToday(db: Db, provider: string, asOf?: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM api_calls
       WHERE provider = ? AND called_at >= date(COALESCE(?, 'now'))
         AND called_at <= COALESCE(?, datetime('now'))`,
    )
    .get(provider, asOf ?? null, asOf ?? null) as { n: number };
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
