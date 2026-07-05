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

// --- api call accounting ---

export interface ApiCallInput {
  provider: string;
  endpoint: string;
  route?: string;
  status?: number;
  ok: boolean;
}

export function recordApiCall(db: Db, c: ApiCallInput): void {
  db.prepare(
    'INSERT INTO api_calls (provider, endpoint, route, status, ok) VALUES (?, ?, ?, ?, ?)',
  ).run(c.provider, c.endpoint, c.route ?? null, c.status ?? null, c.ok ? 1 : 0);
}

/** Calls made since local midnight UTC-agnostic: uses SQLite's date('now'). */
export function apiCallsToday(db: Db, provider: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM api_calls WHERE provider = ? AND called_at >= date('now')`,
    )
    .get(provider) as { n: number };
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
