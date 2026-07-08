import type { Cabin } from '@rate-pirate/shared';
import type {
  ExploreDestination,
  ExploreQuery,
  FlightPriceProvider,
  MonthQuery,
  MonthResult,
  PriceInsights,
  RoundTripQuote,
} from './types.js';

/** A small synthetic destination catalog so demo/tests exercise the Explore
 *  flow offline. IATA → city, country. */
const MOCK_DESTINATIONS: { iata: string; city: string; country: string }[] = [
  { iata: 'CUN', city: 'Cancún', country: 'Mexico' },
  { iata: 'NAP', city: 'Naples', country: 'Italy' },
  { iata: 'LIS', city: 'Lisbon', country: 'Portugal' },
  { iata: 'LAS', city: 'Las Vegas', country: 'United States' },
  { iata: 'SEA', city: 'Seattle', country: 'United States' },
  { iata: 'CDG', city: 'Paris', country: 'France' },
  { iata: 'NRT', city: 'Tokyo', country: 'Japan' },
  { iata: 'SJU', city: 'San Juan', country: 'Puerto Rico' },
  { iata: 'DPS', city: 'Bali', country: 'Indonesia' },
  { iata: 'KEF', city: 'Reykjavík', country: 'Iceland' },
  { iata: 'MEX', city: 'Mexico City', country: 'Mexico' },
  { iata: 'BCN', city: 'Barcelona', country: 'Spain' },
];

/** Rough real-world round-trip price multipliers relative to economy. */
const CABIN_PRICE_FACTOR: Record<Cabin, number> = {
  economy: 1,
  premium_economy: 1.8,
  business: 3.6,
  first: 5.5,
};

export interface SyntheticOptions {
  seed?: number;
  /** Injectable clock so the simulator can fast-forward. */
  now?: () => Date;
}

/** Deterministic synthetic prices: per-route base price + seasonal curve + daily
 *  noise + occasional organic deal drops. Same seed + same date → same quotes. */
export class SyntheticProvider implements FlightPriceProvider {
  readonly name = 'mock';
  private readonly seed: number;
  private readonly now: () => Date;
  /** Manual price overrides for tests: route-month → multiplier. */
  private readonly drops = new Map<string, number>();

  constructor(opts: SyntheticOptions = {}) {
    this.seed = opts.seed ?? 42;
    this.now = opts.now ?? (() => new Date());
  }

  /** Force a deal: quotes for this route-month are multiplied by `multiplier`. */
  injectDrop(destination: string, month: string, multiplier: number): void {
    this.drops.set(`${destination}|${month}`, multiplier);
  }

  clearDrop(destination: string, month: string): void {
    this.drops.delete(`${destination}|${month}`);
  }

  /** Synthetic Explore: the mock catalog ranked cheapest-first for the cabin,
   *  each with representative dates a few weeks out. Deterministic per day. */
  async exploreSearch(q: ExploreQuery): Promise<ExploreDestination[]> {
    const today = this.now();
    const dayKey = Math.floor(today.getTime() / 86_400_000);
    const tripNights = q.tripType === 'weekend' ? 3 : q.tripType === 'one_week' ? 7 : 14;
    const ranked = [...MOCK_DESTINATIONS].sort(
      (a, b) => this.basePrice(a.iata) - this.basePrice(b.iata),
    );
    return ranked.map((d, i) => {
      const depart = new Date((dayKey + 21 + i * 5) * 86_400_000);
      const ret = new Date(depart.getTime() + tripNights * 86_400_000);
      return {
        iata: d.iata,
        city: d.city,
        country: d.country,
        departDate: depart.toISOString().slice(0, 10),
        returnDate: ret.toISOString().slice(0, 10),
      };
    });
  }

  async monthQuotes(q: MonthQuery): Promise<MonthResult> {
    const today = this.now();
    const dayKey = Math.floor(today.getTime() / 86_400_000);
    const base = this.basePrice(q.destination) * CABIN_PRICE_FACTOR[q.cabin];
    const monthNum = Number(q.month.slice(5, 7));
    // Seasonal swing: peaks in summer (northern-hemisphere bias is fine for a mock)
    const seasonal = 1 + 0.18 * Math.sin(((monthNum - 1) / 12) * 2 * Math.PI - Math.PI / 2);
    const drop =
      this.drops.get(`${q.destination}|${q.month}`) ??
      // Organic rare deal: ~4% of route-month-days dip to 60%
      (this.rand(`deal|${q.destination}|${q.month}|${dayKey}`) < 0.04 ? 0.6 : 1);

    const quotes: RoundTripQuote[] = [];
    const count = 3 + Math.floor(this.rand(`n|${q.destination}|${q.month}|${dayKey}`) * 5);
    for (let i = 0; i < count; i++) {
      const key = `q|${q.destination}|${q.month}|${dayKey}|${i}`;
      const noise = 0.9 + this.rand(`${key}|p`) * 0.25;
      // Mirror the real provider: when exact dates are given (an Explore
      // candidate), every quote is for THAT date pair — differing only by
      // flight (price/stops/carrier). Otherwise sample a date within the month.
      let depart: Date;
      let ret: Date;
      if (q.departDate && q.returnDate) {
        depart = new Date(`${q.departDate}T00:00:00Z`);
        ret = new Date(`${q.returnDate}T00:00:00Z`);
      } else {
        const departDay = 1 + Math.floor(this.rand(`${key}|d`) * 26);
        const nights = 4 + Math.floor(this.rand(`${key}|nts`) * 6);
        depart = new Date(Date.UTC(Number(q.month.slice(0, 4)), monthNum - 1, departDay));
        ret = new Date(depart.getTime() + nights * 86_400_000);
      }
      const stops = this.rand(`${key}|s`) < 0.25 ? 0 : 1;
      // Rough synthetic timings: ~3h per hop plus each layover.
      const layovers =
        stops === 0
          ? []
          : [
              {
                airport: ['Denver', 'Dallas', 'Atlanta', 'Chicago', 'Phoenix'][
                  Math.floor(this.rand(`${key}|lv`) * 5)
                ]!,
                minutes: 60 + Math.floor(this.rand(`${key}|lm`) * 180),
              },
            ];
      const durationMinutes =
        180 * (stops + 1) + layovers.reduce((s, l) => s + (l.minutes ?? 0), 0);
      quotes.push({
        origin: q.origin,
        destination: q.destination,
        cabin: q.cabin,
        departDate: depart.toISOString().slice(0, 10),
        returnDate: ret.toISOString().slice(0, 10),
        priceCents: Math.round(base * seasonal * noise * drop * 100),
        currency: 'USD',
        stops,
        carrier: ['AA', 'UA', 'DL', 'BA', 'KL'][Math.floor(this.rand(`${key}|c`) * 5)]!,
        durationMinutes,
        layovers,
      });
    }
    quotes.sort((a, b) => a.priceCents - b.priceCents);
    return { quotes, insights: this.insights(q, base * seasonal, drop, dayKey) };
  }

  /** Deterministic synthetic price insights mirroring the real provider: a level
   *  verdict + a ~60-day series when asked. Mirrors the real Google gap — premium
   *  economy has NO price *history* and no level, only a Price graph (fare across
   *  departure dates); other cabins have history. Both are the same synthetic
   *  distribution; only the source label differs. */
  private insights(q: MonthQuery, typicalUsd: number, drop: number, dayKey: number): PriceInsights {
    const level: PriceInsights['level'] = drop < 0.9 ? 'low' : 'typical';
    if (!q.wantHistory) return { level: q.cabin === 'premium_economy' ? null : level, history: null };
    const series: { date: string; priceCents: number }[] = [];
    for (let daysAgo = 60; daysAgo >= 0; daysAgo--) {
      const day = dayKey - daysAgo;
      const noise = 0.92 + this.rand(`hist|${q.destination}|${q.month}|${q.cabin}|${day}`) * 0.2;
      series.push({
        date: new Date(day * 86_400_000).toISOString().slice(0, 10),
        priceCents: Math.round(typicalUsd * noise * 100),
      });
    }
    // Premium economy: no history/level on Google, baseline comes from the Price graph.
    if (q.cabin === 'premium_economy') return { level: null, history: null, priceGraph: series };
    return { level, history: series };
  }

  /** Stable per-destination base round-trip price in USD (500–1900). */
  private basePrice(destination: string): number {
    return 500 + Math.floor(this.rand(`base|${destination}`) * 1400);
  }

  /** Deterministic [0,1) from string key + seed (FNV-1a → mulberry32). */
  private rand(key: string): number {
    let h = 2166136261 ^ this.seed;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  }
}
