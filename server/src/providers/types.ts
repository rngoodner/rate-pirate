import type { Cabin, Layover, TripType } from '@rate-pirate/shared';

export type { Layover };

/** One Explore search: all destinations from an origin for a cabin + trip type
 *  over the next 6 months. Returns a ranked (cheapest-first) destination list. */
export interface ExploreQuery {
  origin: string;
  cabin: Cabin;
  tripType: TripType;
  adults: number;
}

/** A destination surfaced by Explore, with the trip dates Google picked. Price
 *  is NOT included (Explore doesn't expose it in its data) — the scanner scores
 *  each candidate with a fixed-date fetch. */
export interface ExploreDestination {
  iata: string;
  city: string;
  country: string;
  departDate: string;
  returnDate: string;
}

export interface RoundTripQuote {
  origin: string;
  destination: string;
  cabin: Cabin;
  /** 'YYYY-MM-DD' */
  departDate: string;
  returnDate: string;
  priceCents: number;
  currency: 'USD';
  /** Transfers on the outbound leg; 0 = non-stop. */
  stops: number;
  /** Marketing airline IATA code. */
  carrier: string;
  /** Total outbound travel time in minutes; null when not parsed. */
  durationMinutes: number | null;
  /** Outbound layovers in order; empty for a nonstop. */
  layovers: Layover[];
}

export interface MonthQuery {
  origin: string;
  destination: string;
  cabin: Cabin;
  /** Departure month, 'YYYY-MM'. */
  month: string;
  /** Nights for the representative round trip (default 7). */
  nights?: number;
  /** Departure weekday 0=Sun…6=Sat for the representative trip (default 6). */
  departureDow?: number;
  /** Exact dates to price (from an Explore result); overrides month/nights/dow. */
  departDate?: string;
  returnDate?: string;
  /** Party size to price for (default 1). */
  adults?: number;
  /** Also fetch Google's ~60-day price-history series (costs one in-page
   *  click); the scanner asks only while a route-month lacks its own baseline. */
  wantHistory?: boolean;
}

/** Google's own judgment of the current price, parsed from the results page. */
export interface PriceInsights {
  /** "Prices are currently …" verdict; null if the block wasn't found. */
  level: 'low' | 'typical' | 'high' | null;
  /** Daily prices for this trip over the last ~60 days (oldest first);
   *  null when not requested or the dialog failed to parse. */
  history: { date: string; priceCents: number }[] | null;
  /** Fallback baseline series from Google's "Price graph" (fare across departure
   *  dates), used where the 60-day price *history* doesn't exist — premium
   *  economy. Same shape (date = the bar's departure date). Null when not
   *  applicable or not captured. Its median stands in for the history median. */
  priceGraph?: { date: string; priceCents: number }[] | null;
}

export interface MonthResult {
  quotes: RoundTripQuote[];
  /** Never causes a scan failure — null when unavailable. */
  insights: PriceInsights | null;
}

export interface FlightPriceProvider {
  /** Recorded as the snapshot `source`. */
  readonly name: string;
  /** Cheapest known round-trip quotes for a route + dates. Prices the deal the
   *  scanner is scoring (with exact Explore dates + history). */
  monthQuotes(q: MonthQuery): Promise<MonthResult>;
  /** Discover the cheapest destinations from an origin for a cabin + trip type
   *  over the next ~6 months (Google Flights Explore). Ranked cheapest-first. */
  exploreSearch(q: ExploreQuery): Promise<ExploreDestination[]>;
}

/** One provider request, logged to the api_calls table for quota/debugging. */
export interface CallLog {
  endpoint: string;
  route: string;
  status?: number;
  ok: boolean;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
