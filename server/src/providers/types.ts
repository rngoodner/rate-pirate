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
}

export interface FlightPriceProvider {
  /** Recorded as the snapshot `source`. */
  readonly name: string;
  /** Cheapest known round-trip quotes for a route + departure month.
   *  May return several date pairs; [] when nothing is known for the route. */
  monthQuotes(q: MonthQuery): Promise<RoundTripQuote[]>;
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
