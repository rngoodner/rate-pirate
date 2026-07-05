import { describe, expect, it } from 'vitest';
import { SyntheticProvider } from '../providers/mock.js';
import { mapTpResponse, type TpResponse } from '../providers/travelpayouts.js';

describe('SyntheticProvider', () => {
  const q = { origin: 'ABQ', destination: 'NAP', month: '2026-08' };
  const fixedNow = () => new Date('2026-07-05T12:00:00Z');

  it('is deterministic for the same seed and day', async () => {
    const a = await new SyntheticProvider({ seed: 7, now: fixedNow }).monthQuotes(q);
    const b = await new SyntheticProvider({ seed: 7, now: fixedNow }).monthQuotes(q);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(3);
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
    const quotes = await new SyntheticProvider({ seed: 1, now: fixedNow }).monthQuotes(q);
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

  it('injectDrop lowers prices by the multiplier', async () => {
    const normal = new SyntheticProvider({ seed: 7, now: fixedNow });
    const dropped = new SyntheticProvider({ seed: 7, now: fixedNow });
    dropped.injectDrop('NAP', '2026-08', 0.5);
    const [a, b] = await Promise.all([normal.monthQuotes(q), dropped.monthQuotes(q)]);
    // Same seed/day so quotes pair up 1:1 after sorting
    expect(b[0]!.priceCents).toBeLessThan(a[0]!.priceCents);
    expect(b[0]!.priceCents / a[0]!.priceCents).toBeCloseTo(0.5, 1);
  });
});

describe('mapTpResponse', () => {
  const q = { origin: 'ABQ', destination: 'NAP', month: '2026-08' };

  it('maps tickets and converts price to cents', () => {
    const res: TpResponse = {
      success: true,
      currency: 'usd',
      data: [
        {
          origin: 'ABQ',
          destination: 'NAP',
          departure_at: '2026-08-18T07:00:00-06:00',
          return_at: '2026-08-26T09:05:00+02:00',
          price: 758.4,
          airline: 'KL',
          transfers: 1,
        },
      ],
    };
    expect(mapTpResponse(res, q)).toEqual([
      {
        origin: 'ABQ',
        destination: 'NAP',
        departDate: '2026-08-18',
        returnDate: '2026-08-26',
        priceCents: 75840,
        currency: 'USD',
        stops: 1,
        carrier: 'KL',
      },
    ]);
  });

  it('drops one-way tickets and off-month departures', () => {
    const res: TpResponse = {
      success: true,
      currency: 'usd',
      data: [
        { origin: 'ABQ', destination: 'NAP', departure_at: '2026-08-18T07:00:00Z', price: 400, airline: 'AA', transfers: 1 },
        { origin: 'ABQ', destination: 'NAP', departure_at: '2026-09-02T07:00:00Z', return_at: '2026-09-09T10:00:00Z', price: 700, airline: 'AA', transfers: 1 },
      ],
    };
    expect(mapTpResponse(res, q)).toEqual([]);
  });

  it('returns [] for unsuccessful or empty responses', () => {
    expect(mapTpResponse({ success: false, currency: 'usd', data: [] }, q)).toEqual([]);
    expect(mapTpResponse({ success: true, currency: 'usd', data: [] }, q)).toEqual([]);
  });
});
