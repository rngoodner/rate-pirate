/** API wire types shared between server and web. */

/** Cabin / fare classes the app can monitor. Stored and compared by these keys. */
export const CABINS = ['economy', 'premium_economy', 'business', 'first'] as const;
export type Cabin = (typeof CABINS)[number];

export const CABIN_LABELS: Record<Cabin, string> = {
  economy: 'Economy',
  premium_economy: 'Premium Economy',
  business: 'Business',
  first: 'First',
};

export function isCabin(value: string): value is Cabin {
  return (CABINS as readonly string[]).includes(value);
}

/** Split a recipient field into individual addresses. Accepts comma / semicolon
 *  / whitespace / newline separators so "a@x.com, b@y.com" → ['a@x.com','b@y.com']. */
export function parseRecipients(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

// --- Google Flights deep link (tfs protobuf) ---
// The natural-language `?q=` form asks Google to PARSE a sentence, and the
// mobile site intermittently fails to apply it (user lands on an empty
// "Where to?" form). `?tfs=` is the deterministic deep-link format: a
// base64url protobuf carrying route/dates/cabin exactly. Field numbers per
// the community-reverse-engineered schema (fast-flights): Info{data=3 legs,
// passengers=8, seat=9, trip=19}, FlightData{date=2, from=13, to=14},
// Airport{airport=2}. (The scraper still uses `?q=` — proven reliable
// headless, and its parser depends on that page variant.)

const SEAT_NUM: Record<Cabin, number> = { economy: 1, premium_economy: 2, business: 3, first: 4 };

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function lenDelim(field: number, bytes: number[]): number[] {
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
}

/** ASCII-only (IATA codes and ISO dates). */
function strField(field: number, s: string): number[] {
  return lenDelim(field, [...s].map((c) => c.charCodeAt(0)));
}

function enumField(field: number, v: number): number[] {
  return [...varint((field << 3) | 0), ...varint(v)];
}

function leg(date: string, from: string, to: string): number[] {
  return [...strField(2, date), ...lenDelim(13, strField(2, from)), ...lenDelim(14, strField(2, to))];
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function base64url(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [b0, b1, b2] = [bytes[i]!, bytes[i + 1], bytes[i + 2]];
    out += B64URL[b0 >> 2]! + B64URL[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 !== undefined) out += B64URL[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 !== undefined) out += B64URL[b2 & 63]!;
  }
  return out;
}

/** Where-to-buy deep link — Rate Pirate never books flights itself. */
export function googleFlightsUrl(
  origin: string,
  destination: string,
  departDate: string,
  returnDate: string,
  cabin: Cabin = 'economy',
): string {
  const info = [
    ...lenDelim(3, leg(departDate, origin, destination)),
    ...lenDelim(3, leg(returnDate, destination, origin)),
    ...enumField(8, 1), // one adult
    ...enumField(9, SEAT_NUM[cabin]),
    ...enumField(19, 1), // round trip
  ];
  return `https://www.google.com/travel/flights?tfs=${base64url(info)}&hl=en&curr=USD`;
}

export interface Deal {
  id: number;
  origin: string;
  destination: string;
  city: string;
  country: string;
  cabin: Cabin;
  /** Departure month bucket, 'YYYY-MM'. */
  travelMonth: string;
  bestPriceCents: number;
  baselinePriceCents: number;
  /** 0..1 fraction below baseline. */
  discountPct: number;
  /** 0–100. */
  score: number;
  departDate: string;
  returnDate: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status: 'active' | 'expired';
  /** 'observed' = our own scan history; 'google' = bootstrapped from Google's
   *  price-history graph while our history is still building. */
  baselineSource: 'observed' | 'google';
}

export interface DealDateOption {
  departDate: string;
  returnDate: string;
  nights: number;
  priceCents: number;
  baselinePriceCents: number | null;
  capturedAt: string;
  googleFlightsUrl: string;
}

/** One point of the deal page's price-history sparkline (daily minimum). */
export interface PricePoint {
  /** 'YYYY-MM-DD' capture day. */
  date: string;
  priceCents: number;
}

export interface DealDetail extends Deal {
  dateOptions: DealDateOption[];
  /** Daily-minimum price history for this route-month (last ~60 days). */
  priceHistory: PricePoint[];
  /** Whose history the sparkline charts: ours, or Google's while ours builds. */
  priceHistorySource: 'observed' | 'google';
}

/** A scannable destination; `active` = included in the scan rotation. */
export interface Destination {
  iata: string;
  city: string;
  country: string;
  region: string;
  /** 1 = favorite (scanned most often) … 3 = long-tail. */
  tier: number;
  active: boolean;
}

export interface Settings {
  homeAirport: string;
  alertEmail: string;
  /** Minimum deal score (0–100) that triggers an email. */
  alertThreshold: number;
  dailyCallBudget: number;
  scanEnabled: boolean;
  /** Cabins to monitor; at least one. More cabins = slower scan cadence. */
  monitoredCabins: Cabin[];
  /** Hard floor: never alert on less than this discount (0..1 fraction). */
  alertMinDiscount: number;
  /** Feed floor: a price must be this far below baseline (0..1 fraction) to
   *  count as a deal at all; deals expire back below it. */
  dealMinDiscount: number;
  /** Days without re-alerting the same route-month (unless the price deepens). */
  alertCooldownDays: number;
  /** How many months ahead to scan; scales the scan universe. */
  scanHorizonMonths: number;
}

export interface ScanStatus {
  provider: string;
  lastScanAt: string | null;
  callsToday: number;
  dailyCallBudget: number;
  /** Fraction of active route-months that have enough history for a baseline. */
  baselineCoverage: number;
  activeDeals: number;
  /** Error events logged today (local day). */
  errorsToday: number;
  /** Server-judged "scanning is effectively broken" — drives the feed's red
   *  banner. True on a high failure share of today's calls, or on repeated
   *  batch-level errors (crashes, zero-price anomaly). */
  scansBroken: boolean;
  /** SQLite UTC timestamp of the next scheduled batch; null while paused. */
  nextBatchAt: string | null;
}

/** One row of the in-app activity/error log (Settings → Activity log). */
export interface AppEvent {
  id: number;
  level: 'info' | 'error';
  scope: string;
  message: string;
  detail: string | null;
  /** SQLite UTC timestamp, 'YYYY-MM-DD HH:MM:SS'. */
  createdAt: string;
}
