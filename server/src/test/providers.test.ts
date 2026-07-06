import { describe, expect, it } from 'vitest';
import { SyntheticProvider } from '../providers/mock.js';

describe('SyntheticProvider', () => {
  const q = { origin: 'ABQ', destination: 'NAP', cabin: 'economy' as const, month: '2026-08' };
  const fixedNow = () => new Date('2026-07-05T12:00:00Z');

  it('is deterministic for the same seed and day', async () => {
    const a = await new SyntheticProvider({ seed: 7, now: fixedNow }).monthQuotes(q);
    const b = await new SyntheticProvider({ seed: 7, now: fixedNow }).monthQuotes(q);
    expect(a).toEqual(b);
    expect(a.quotes.length).toBeGreaterThanOrEqual(3);
  });

  it('varies across seeds and days', async () => {
    const a = await new SyntheticProvider({ seed: 7, now: fixedNow }).monthQuotes(q);
    const b = await new SyntheticProvider({ seed: 8, now: fixedNow }).monthQuotes(q);
    const c = await new SyntheticProvider({
      seed: 7,
      now: () => new Date('2026-07-06T12:00:00Z'),
    }).monthQuotes(q);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('produces sane quotes: sorted, in-month, positive prices, sensible stays', async () => {
    const { quotes } = await new SyntheticProvider({ seed: 1, now: fixedNow }).monthQuotes(q);
    for (let i = 1; i < quotes.length; i++) {
      expect(quotes[i]!.priceCents).toBeGreaterThanOrEqual(quotes[i - 1]!.priceCents);
    }
    for (const quote of quotes) {
      expect(quote.departDate.startsWith('2026-08')).toBe(true);
      expect(quote.priceCents).toBeGreaterThan(0);
      const nights =
        (Date.parse(quote.returnDate) - Date.parse(quote.departDate)) / 86_400_000;
      expect(nights).toBeGreaterThanOrEqual(4);
      expect(nights).toBeLessThanOrEqual(9);
    }
  });

  it('injectDrop lowers prices by the multiplier and flips the insights level', async () => {
    const normal = new SyntheticProvider({ seed: 7, now: fixedNow });
    const dropped = new SyntheticProvider({ seed: 7, now: fixedNow });
    dropped.injectDrop('NAP', '2026-08', 0.5);
    const [a, b] = await Promise.all([normal.monthQuotes(q), dropped.monthQuotes(q)]);
    // Same seed/day so quotes pair up 1:1 after sorting
    expect(b.quotes[0]!.priceCents).toBeLessThan(a.quotes[0]!.priceCents);
    expect(b.quotes[0]!.priceCents / a.quotes[0]!.priceCents).toBeCloseTo(0.5, 1);
    expect(b.insights?.level).toBe('low');
  });

  it('scales price by cabin', async () => {
    const now = () => new Date('2026-07-05T12:00:00Z');
    const econ = (await new SyntheticProvider({ seed: 3, now }).monthQuotes({ ...q, cabin: 'economy' })).quotes;
    const biz = (await new SyntheticProvider({ seed: 3, now }).monthQuotes({ ...q, cabin: 'business' })).quotes;
    // Business is markedly pricier than economy for the same route/day
    expect(Math.min(...biz.map((x) => x.priceCents))).toBeGreaterThan(
      Math.min(...econ.map((x) => x.priceCents)) * 2,
    );
    expect(biz.every((x) => x.cabin === 'business')).toBe(true);
  });

  it('synthesizes a ~60-day history series only when asked', async () => {
    const p = new SyntheticProvider({ seed: 5, now: fixedNow });
    const without = await p.monthQuotes(q);
    expect(without.insights?.history).toBeNull();
    const withHist = await p.monthQuotes({ ...q, wantHistory: true });
    expect(withHist.insights?.history?.length).toBe(61);
    // Deterministic and centered near the route's typical price
    const again = await p.monthQuotes({ ...q, wantHistory: true });
    expect(withHist.insights).toEqual(again.insights);
  });
});
