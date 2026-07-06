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

/** Natural-language phrase Google Flights understands for each cabin ('' = economy default). */
export const CABIN_QUERY_PHRASE: Record<Cabin, string> = {
  economy: '',
  premium_economy: 'premium economy',
  business: 'business class',
  first: 'first class',
};

export function isCabin(value: string): value is Cabin {
  return (CABINS as readonly string[]).includes(value);
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

export interface DealDetail extends Deal {
  dateOptions: DealDateOption[];
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
}

export interface ScanStatus {
  provider: string;
  lastScanAt: string | null;
  callsToday: number;
  dailyCallBudget: number;
  /** Fraction of active route-months that have enough history for a baseline. */
  baselineCoverage: number;
  activeDeals: number;
}
