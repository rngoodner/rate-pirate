/** API wire types shared between server and web. */

/** Where-to-buy deep link — Rate Pirate never books flights itself. */
export function googleFlightsUrl(
  origin: string,
  destination: string,
  departDate: string,
  returnDate: string,
): string {
  const q = `Flights from ${origin} to ${destination} on ${departDate} through ${returnDate}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

export interface Deal {
  id: number;
  origin: string;
  destination: string;
  city: string;
  country: string;
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
