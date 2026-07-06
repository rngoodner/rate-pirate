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

/** Natural-language phrase appended to a Google Flights query for each cabin
 *  ('' = economy default). The leading "in" matters: Google's query parser
 *  applies the cabin filter for "… in business class" but ignores a bare
 *  "… business class" (verified live — the bare form returns no results). */
export const CABIN_QUERY_PHRASE: Record<Cabin, string> = {
  economy: '',
  premium_economy: 'in premium economy',
  business: 'in business class',
  first: 'in first class',
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

/** Where-to-buy deep link — Rate Pirate never books flights itself. */
export function googleFlightsUrl(
  origin: string,
  destination: string,
  departDate: string,
  returnDate: string,
  cabin: Cabin = 'economy',
): string {
  const phrase = CABIN_QUERY_PHRASE[cabin];
  const q =
    `Flights from ${origin} to ${destination} on ${departDate} through ${returnDate}` +
    (phrase ? ` ${phrase}` : '');
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
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
