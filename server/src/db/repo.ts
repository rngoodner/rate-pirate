import type { Cabin, Layover, TripType } from '@rate-pirate/shared';
import type { Db } from './db.js';

export interface SnapshotInput {
  origin: string;
  destination: string;
  city: string;
  country: string;
  cabin: Cabin;
  tripType: TripType;
  travelMonth: string;
  departDate: string;
  returnDate: string;
  priceCents: number;
  stops: number | null;
  carrier: string | null;
  /** Total outbound duration in minutes; optional (older/unparsed labels lack it). */
  durationMinutes?: number | null;
  /** Outbound layovers; optional, defaults to none. */
  layovers?: Layover[];
  source: string;
  /** ISO timestamp override for tests/simulator; defaults to now. */
  capturedAt?: string;
}

// duration/layovers are write-only detail surfaced via recentDateOptions, not
// part of the core snapshot row the detector reads.
export interface SnapshotRow
  extends Required<Omit<SnapshotInput, 'capturedAt' | 'durationMinutes' | 'layovers'>> {
  id: number;
  capturedAt: string;
}

const snapshotCols = `id, source, origin, destination, city, country, cabin,
  trip_type AS tripType, travel_month AS travelMonth, depart_date AS departDate,
  return_date AS returnDate, price_cents AS priceCents, stops, carrier, captured_at AS capturedAt`;

export function insertSnapshot(db: Db, s: SnapshotInput): void {
  db.prepare(
    `INSERT INTO price_snapshots
       (source, origin, destination, city, country, cabin, trip_type, travel_month,
        depart_date, return_date, price_cents, stops, carrier, duration_minutes, layovers, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(
    s.source,
    s.origin,
    s.destination,
    s.city,
    s.country,
    s.cabin,
    s.tripType,
    s.travelMonth,
    s.departDate,
    s.returnDate,
    s.priceCents,
    s.stops,
    s.carrier,
    s.durationMinutes ?? null,
    s.layovers && s.layovers.length ? JSON.stringify(s.layovers) : null,
    s.capturedAt ?? null,
  );
}

export function pruneSnapshots(db: Db, olderThanDays: number): number {
  return db
    .prepare(`DELETE FROM price_snapshots WHERE captured_at < datetime('now', '-' || ? || ' days')`)
    .run(olderThanDays).changes;
}

/** Snapshots from the most recent scan of a (destination, cabin, trip_type)
 *  combo — all share captured_at, cheapest first. */
export function latestScanSnapshots(
  db: Db,
  source: string,
  origin: string,
  destination: string,
  cabin: Cabin,
  tripType: TripType,
  asOf?: string,
): SnapshotRow[] {
  return db
    .prepare(
      `SELECT ${snapshotCols} FROM price_snapshots
       WHERE source = ? AND origin = ? AND destination = ? AND cabin = ? AND trip_type = ?
         AND captured_at = (
           SELECT MAX(captured_at) FROM price_snapshots
           WHERE source = ? AND origin = ? AND destination = ? AND cabin = ? AND trip_type = ?
             AND captured_at <= COALESCE(?, datetime('now'))
         )
       ORDER BY price_cents`,
    )
    .all(
      source,
      origin,
      destination,
      cabin,
      tripType,
      source,
      origin,
      destination,
      cabin,
      tripType,
      asOf ?? null,
    ) as SnapshotRow[];
}

/** Distinct (destination, cabin, trip_type) combos with a recent snapshot, each
 *  carrying its latest place info. Drives feed-floor re-evaluation over stored
 *  data (no provider calls). */
export function recentSnapshotCombos(
  db: Db,
  source: string,
  origin: string,
  sinceDays: number,
): { destination: string; city: string; country: string; cabin: Cabin; tripType: TripType }[] {
  return db
    .prepare(
      `SELECT destination, cabin, trip_type AS tripType,
              -- place info from the most recent snapshot of the combo
              (SELECT city FROM price_snapshots s2
               WHERE s2.source = s.source AND s2.origin = s.origin
                 AND s2.destination = s.destination AND s2.cabin = s.cabin
                 AND s2.trip_type = s.trip_type
               ORDER BY captured_at DESC LIMIT 1) AS city,
              (SELECT country FROM price_snapshots s2
               WHERE s2.source = s.source AND s2.origin = s.origin
                 AND s2.destination = s.destination AND s2.cabin = s.cabin
                 AND s2.trip_type = s.trip_type
               ORDER BY captured_at DESC LIMIT 1) AS country
       FROM price_snapshots s
       WHERE source = ? AND origin = ?
         AND captured_at >= datetime('now', '-' || ? || ' days')
       GROUP BY destination, cabin, trip_type`,
    )
    .all(source, origin, sinceDays) as {
    destination: string;
    city: string;
    country: string;
    cabin: Cabin;
    tripType: TripType;
  }[];
}

// --- deals ---

export interface DealRow {
  id: number;
  source: string;
  origin: string;
  destination: string;
  city: string;
  country: string;
  cabin: Cabin;
  tripType: TripType;
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
  /** Carrier of the deal's cheapest current fare — the same snapshot the price
   *  and dates come from (see the `carrier` subquery in dealCols). Null when no
   *  snapshot or no carrier was captured. */
  carrier: string | null;
}

// The correlated `carrier` subquery picks the exact fare this deal describes —
// the cheapest itinerary from the most recent scan of the combo — matching
// dealFlightDetails so the feed's airline and the detail page never disagree.
const dealCols = `id, source, origin, destination, city, country, cabin,
  trip_type AS tripType, travel_month AS travelMonth,
  best_price_cents AS bestPriceCents, baseline_price_cents AS baselinePriceCents,
  discount_pct AS discountPct, score, depart_date AS departDate, return_date AS returnDate,
  first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, status,
  (SELECT carrier FROM price_snapshots s
    WHERE s.source = deals.source AND s.origin = deals.origin
      AND s.destination = deals.destination AND s.cabin = deals.cabin
      AND s.trip_type = deals.trip_type
    ORDER BY s.captured_at DESC, s.price_cents ASC LIMIT 1) AS carrier`;

export interface DealInput {
  source: string;
  origin: string;
  destination: string;
  city: string;
  country: string;
  cabin: Cabin;
  tripType: TripType;
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
    `INSERT INTO deals (source, origin, destination, city, country, cabin, trip_type, travel_month,
       best_price_cents, baseline_price_cents, discount_pct, score, depart_date, return_date,
       first_seen_at, last_seen_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(source, origin, destination, cabin, trip_type) DO UPDATE SET
       city = excluded.city,
       country = excluded.country,
       travel_month = excluded.travel_month,
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
    d.city,
    d.country,
    d.cabin,
    d.tripType,
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
  return getDealByCombo(db, d.source, d.origin, d.destination, d.cabin, d.tripType)!;
}

export function getDealByCombo(
  db: Db,
  source: string,
  origin: string,
  destination: string,
  cabin: Cabin,
  tripType: TripType,
): DealRow | null {
  return (
    (db
      .prepare(
        `SELECT ${dealCols} FROM deals
         WHERE source = ? AND origin = ? AND destination = ? AND cabin = ? AND trip_type = ?`,
      )
      .get(source, origin, destination, cabin, tripType) as DealRow | undefined) ?? null
  );
}

export function getDeal(db: Db, id: number): DealRow | null {
  return (
    (db.prepare(`SELECT ${dealCols} FROM deals WHERE id = ?`).get(id) as DealRow | undefined) ??
    null
  );
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
 *  airport changed), a departure date already in the past, or a cabin/trip-type
 *  the user no longer monitors. Without this, such "zombie" deals sit in the
 *  feed showing stale prices indefinitely. Deals for still-monitored combos are
 *  left alone (the feed hides unselected cabins but keeps the data). */
export function expireDealsOutsideUniverse(
  db: Db,
  opts: {
    source: string;
    origin: string;
    today: string;
    cabins: Cabin[];
    tripTypes: TripType[];
  },
): number {
  const cabinPh = opts.cabins.map(() => '?').join(', ') || `''`;
  const tripPh = opts.tripTypes.map(() => '?').join(', ') || `''`;
  return db
    .prepare(
      `UPDATE deals SET status = 'expired'
       WHERE status = 'active' AND source = ?
         AND (origin != ? OR depart_date < ?
           OR cabin NOT IN (${cabinPh}) OR trip_type NOT IN (${tripPh}))`,
    )
    .run(opts.source, opts.origin, opts.today, ...opts.cabins, ...opts.tripTypes).changes;
}

/** Expire active deals for a (cabin, trip_type) combo whose destination wasn't
 *  in the latest Explore search — inherent shown-deal verification: a deal that
 *  no longer ranks among Explore's results for its trip shape is gone. */
export function expireDealsNotSeen(
  db: Db,
  source: string,
  origin: string,
  cabin: Cabin,
  tripType: TripType,
  keepDestinations: string[],
): number {
  const ph = keepDestinations.map(() => '?').join(', ') || `''`;
  return db
    .prepare(
      `UPDATE deals SET status = 'expired'
       WHERE status = 'active' AND source = ? AND origin = ? AND cabin = ? AND trip_type = ?
         AND destination NOT IN (${ph})`,
    )
    .run(source, origin, cabin, tripType, ...keepDestinations).changes;
}

export type DealWithPlace = DealRow;

/** Active deals for the given source, restricted to the cabins AND trip types
 *  the user currently monitors (the feed hides deals for either dimension the
 *  user de-selected — until the next scan expires them). Empty set → no deals. */
export function activeDealsWithPlace(
  db: Db,
  source: string,
  cabins: Cabin[],
  tripTypes: TripType[],
): DealWithPlace[] {
  if (cabins.length === 0 || tripTypes.length === 0) return [];
  const cabinPh = cabins.map(() => '?').join(', ');
  const tripPh = tripTypes.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT ${dealCols} FROM deals
       WHERE source = ? AND status = 'active'
         AND cabin IN (${cabinPh}) AND trip_type IN (${tripPh})
       ORDER BY score DESC, discount_pct DESC`,
    )
    .all(source, ...cabins, ...tripTypes) as DealWithPlace[];
}

export function getDealWithPlace(db: Db, id: number): DealWithPlace | null {
  return getDeal(db, id);
}

/** Flight specifics (stops, carrier, outbound duration, layovers) of the fare a
 *  deal describes: the cheapest itinerary from the most recent scan of the combo
 *  — the same snapshot the deal's price/dates come from. Null if none stored. */
export function dealFlightDetails(
  db: Db,
  source: string,
  origin: string,
  destination: string,
  cabin: Cabin,
  tripType: TripType,
): { stops: number | null; carrier: string | null; durationMinutes: number | null; layovers: Layover[] } | null {
  const row = db
    .prepare(
      `SELECT stops, carrier, duration_minutes AS durationMinutes, layovers AS layoversJson
       FROM price_snapshots
       WHERE source = ? AND origin = ? AND destination = ? AND cabin = ? AND trip_type = ?
       ORDER BY captured_at DESC, price_cents ASC LIMIT 1`,
    )
    .get(source, origin, destination, cabin, tripType) as
    | { stops: number | null; carrier: string | null; durationMinutes: number | null; layoversJson: string | null }
    | undefined;
  if (!row) return null;
  const { layoversJson, ...rest } = row;
  return { ...rest, layovers: layoversJson ? (JSON.parse(layoversJson) as Layover[]) : [] };
}

/** Distinct non-null carrier strings seen for a route origin in the last
 *  `sinceDays` days — the raw material for the airline filter's checklist. The
 *  caller collapses these to primary airlines (see primaryAirline). */
export function distinctRecentCarriers(
  db: Db,
  source: string,
  origin: string,
  sinceDays: number,
): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT carrier FROM price_snapshots
         WHERE source = ? AND origin = ? AND carrier IS NOT NULL AND carrier != ''
           AND captured_at >= datetime('now', '-' || ? || ' days')`,
      )
      .all(source, origin, sinceDays) as { carrier: string }[]
  ).map((r) => r.carrier);
}

// --- Google price insights (baselines + sparkline) ---

export interface PriceInsightsRow {
  level: 'low' | 'typical' | 'high' | null;
  medianCents: number | null;
  /** Parsed series, oldest first; [] when none was captured. */
  series: { date: string; priceCents: number }[];
  /** Where `series` came from: Google price history, or the Price graph (premium
   *  economy). Null when no series has been captured. */
  seriesKind: 'history' | 'price_graph' | null;
  capturedAt: string;
}

export function upsertPriceInsights(
  db: Db,
  key: { source: string; origin: string; destination: string; cabin: Cabin; tripType: TripType },
  insights: {
    level: string | null;
    history: { date: string; priceCents: number }[] | null;
    /** Price-graph fallback (premium economy); used when there's no history. */
    priceGraph?: { date: string; priceCents: number }[] | null;
    capturedAt: string;
  },
): void {
  // Prefer the 60-day history; fall back to the Price graph where history doesn't
  // exist (premium economy). Both feed the same median — the baseline is the
  // median either way — but we record which source so the UI can label it.
  const series = insights.history?.length ? insights.history : (insights.priceGraph ?? []);
  const seriesKind = insights.history?.length
    ? 'history'
    : insights.priceGraph?.length
      ? 'price_graph'
      : null;
  const prices = series.map((p) => p.priceCents);
  const medianCents = prices.length
    ? [...prices].sort((a, b) => a - b)[Math.floor(prices.length / 2)]!
    : null;
  db.prepare(
    `INSERT INTO price_insights (source, origin, destination, cabin, trip_type,
       level, median_cents, series_json, series_kind, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, origin, destination, cabin, trip_type) DO UPDATE SET
       level = excluded.level,
       -- Keep an earlier series if a later capture didn't fetch one.
       median_cents = COALESCE(excluded.median_cents, price_insights.median_cents),
       series_json = COALESCE(excluded.series_json, price_insights.series_json),
       series_kind = COALESCE(excluded.series_kind, price_insights.series_kind),
       captured_at = excluded.captured_at`,
  ).run(
    key.source,
    key.origin,
    key.destination,
    key.cabin,
    key.tripType,
    insights.level,
    medianCents,
    // Treat an empty series like none (store NULL), so the COALESCE above
    // preserves an earlier good series instead of overwriting it with '[]'.
    series.length ? JSON.stringify(series.map((p) => [p.date, p.priceCents])) : null,
    series.length ? seriesKind : null,
    insights.capturedAt,
  );
}

export function getPriceInsights(
  db: Db,
  source: string,
  origin: string,
  destination: string,
  cabin: Cabin,
  tripType: TripType,
): PriceInsightsRow | null {
  const row = db
    .prepare(
      `SELECT level, median_cents AS medianCents, series_json AS seriesJson,
              series_kind AS seriesKind, captured_at AS capturedAt
       FROM price_insights
       WHERE source = ? AND origin = ? AND destination = ? AND cabin = ? AND trip_type = ?`,
    )
    .get(source, origin, destination, cabin, tripType) as
    | {
        level: PriceInsightsRow['level'];
        medianCents: number | null;
        seriesJson: string | null;
        seriesKind: PriceInsightsRow['seriesKind'];
        capturedAt: string;
      }
    | undefined;
  if (!row) return null;
  const series = row.seriesJson
    ? (JSON.parse(row.seriesJson) as [string, number][]).map(([date, priceCents]) => ({
        date,
        priceCents,
      }))
    : [];
  return {
    level: row.level,
    medianCents: row.medianCents,
    series,
    seriesKind: row.seriesKind ?? null,
    capturedAt: row.capturedAt,
  };
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

/** Zero today's call count for a provider (admin "reset daily budget"): drop the
 *  api_calls rows counted by apiCallsToday so scanning can resume within the same
 *  local day. Mirrors apiCallsToday's local-day window so it clears exactly what
 *  is counted. Returns how many rows were cleared. */
export function resetDailyBudget(db: Db, provider: string): number {
  return db
    .prepare(
      `DELETE FROM api_calls
       WHERE provider = ? AND datetime(called_at, 'localtime') >= date('now', 'localtime')`,
    )
    .run(provider).changes;
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

export function clearEvents(db: Db): number {
  return db.prepare('DELETE FROM app_events').run().changes;
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
    db.prepare(`DELETE FROM price_insights WHERE source = 'mock'`).run();
    return deals + snaps;
  })();
}
