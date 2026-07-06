import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Cabin } from '@rate-pirate/shared';
import type { FlightPriceProvider, MonthQuery, RoundTripQuote } from './types.js';
import { mapTpResponse, type TpResponse } from './travelpayouts.js';

/** Rough real-world round-trip price multipliers relative to economy. */
const CABIN_PRICE_FACTOR: Record<Cabin, number> = {
  economy: 1,
  premium_economy: 1.8,
  business: 3.6,
  first: 5.5,
};

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Replays raw Travelpayouts responses recorded by scripts/record-fixtures.ts. */
export class FixtureProvider implements FlightPriceProvider {
  readonly name = 'mock';

  async monthQuotes(q: MonthQuery): Promise<RoundTripQuote[]> {
    const file = join(fixturesDir, `${q.origin}-${q.destination}-${q.month}.json`);
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf8')) as TpResponse;
    return mapTpResponse(raw, q);
  }
}

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

  async monthQuotes(q: MonthQuery): Promise<RoundTripQuote[]> {
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
      const departDay = 1 + Math.floor(this.rand(`${key}|d`) * 26);
      const nights = 4 + Math.floor(this.rand(`${key}|nts`) * 6);
      const noise = 0.9 + this.rand(`${key}|p`) * 0.25;
      const depart = new Date(Date.UTC(Number(q.month.slice(0, 4)), monthNum - 1, departDay));
      const ret = new Date(depart.getTime() + nights * 86_400_000);
      quotes.push({
        origin: q.origin,
        destination: q.destination,
        cabin: q.cabin,
        departDate: depart.toISOString().slice(0, 10),
        returnDate: ret.toISOString().slice(0, 10),
        priceCents: Math.round(base * seasonal * noise * drop * 100),
        currency: 'USD',
        stops: this.rand(`${key}|s`) < 0.25 ? 0 : 1,
        carrier: ['AA', 'UA', 'DL', 'BA', 'KL'][Math.floor(this.rand(`${key}|c`) * 5)]!,
      });
    }
    return quotes.sort((a, b) => a.priceCents - b.priceCents);
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
