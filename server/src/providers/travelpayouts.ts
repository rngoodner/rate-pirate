import type { FlightPriceProvider, MonthQuery, RoundTripQuote } from './types.js';
import { ProviderError } from './types.js';

const BASE_URL = 'https://api.travelpayouts.com/aviasales/v3/prices_for_dates';
const MIN_CALL_GAP_MS = 200;

/** Raw shape of one ticket in the v3 prices_for_dates response. */
export interface TpTicket {
  origin: string;
  destination: string;
  departure_at: string; // ISO datetime
  return_at?: string; // ISO datetime, present for round trips
  price: number; // in requested currency units
  airline: string;
  transfers: number;
  return_transfers?: number;
  link?: string;
}

export interface TpResponse {
  success: boolean;
  data: TpTicket[];
  currency: string;
}

export interface CallLog {
  endpoint: string;
  route: string;
  status?: number;
  ok: boolean;
}

/** Maps a raw Travelpayouts response to quotes; exported so fixture replay reuses it.
 *  The Aviasales cache is economy-only, so non-economy queries yield nothing. */
export function mapTpResponse(res: TpResponse, q: MonthQuery): RoundTripQuote[] {
  if (q.cabin !== 'economy') return [];
  if (!res.success || !Array.isArray(res.data)) return [];
  return res.data
    .filter((t) => t.return_at && t.departure_at.startsWith(q.month))
    .map((t) => ({
      origin: q.origin,
      destination: q.destination,
      cabin: q.cabin,
      departDate: t.departure_at.slice(0, 10),
      returnDate: t.return_at!.slice(0, 10),
      priceCents: Math.round(t.price * 100),
      currency: 'USD' as const,
      stops: t.transfers,
      carrier: t.airline,
    }));
}

export class TravelpayoutsProvider implements FlightPriceProvider {
  readonly name = 'travelpayouts';
  private lastCallAt = 0;

  constructor(
    private readonly token: string,
    private readonly onCall?: (log: CallLog) => void,
  ) {}

  async monthQuotes(q: MonthQuery): Promise<RoundTripQuote[]> {
    if (q.cabin !== 'economy') return []; // Aviasales cache is economy-only
    const raw = await this.fetchRaw(q);
    return mapTpResponse(raw, q);
  }

  /** Fetch the unmapped response (used by the fixture recorder). */
  async fetchRaw(q: MonthQuery): Promise<TpResponse> {
    const params = new URLSearchParams({
      origin: q.origin,
      destination: q.destination,
      departure_at: q.month,
      one_way: 'false',
      currency: 'usd',
      sorting: 'price',
      limit: '30',
    });
    const url = `${BASE_URL}?${params}`;
    const route = `${q.origin}-${q.destination} ${q.month}`;

    let lastError: ProviderError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.throttle();
      if (attempt > 0) await sleep(1000);
      let status: number | undefined;
      try {
        const res = await fetch(url, { headers: { 'X-Access-Token': this.token } });
        status = res.status;
        if (res.ok) {
          this.onCall?.({ endpoint: 'prices_for_dates', route, status, ok: true });
          return (await res.json()) as TpResponse;
        }
        this.onCall?.({ endpoint: 'prices_for_dates', route, status, ok: false });
        lastError = new ProviderError(`travelpayouts ${status} for ${route}`, status);
        // 4xx other than 429 won't improve on retry
        if (status < 500 && status !== 429) throw lastError;
      } catch (err) {
        if (err instanceof ProviderError) {
          if (err.status !== undefined && err.status < 500 && err.status !== 429) throw err;
          lastError = err;
        } else {
          this.onCall?.({ endpoint: 'prices_for_dates', route, ok: false });
          lastError = new ProviderError(`travelpayouts network error for ${route}: ${err}`);
        }
      }
    }
    throw lastError ?? new ProviderError(`travelpayouts failed for ${route}`);
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + MIN_CALL_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
