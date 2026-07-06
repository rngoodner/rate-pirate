import type { Cabin } from '@rate-pirate/shared';

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
}

export interface MonthQuery {
  origin: string;
  destination: string;
  cabin: Cabin;
  /** Departure month, 'YYYY-MM'. */
  month: string;
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
}

export interface MonthResult {
  quotes: RoundTripQuote[];
  /** Never causes a scan failure — null when unavailable. */
  insights: PriceInsights | null;
}

export interface FlightPriceProvider {
  /** Recorded as the snapshot `source`. */
  readonly name: string;
  /** Cheapest known round-trip quotes for a route + departure month.
   *  May return several date pairs; quotes=[] when nothing is known. */
  monthQuotes(q: MonthQuery): Promise<MonthResult>;
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
