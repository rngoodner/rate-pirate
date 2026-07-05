import { describe, expect, it } from 'vitest';
import { parseResultLabel, representativeDates } from '../providers/google-flights.js';

describe('parseResultLabel', () => {
  it('parses price, stops, and carrier from a result aria-label', () => {
    expect(
      parseResultLabel(
        'From 885 US dollars round trip total. 1 stop flight with Delta. Leaves Albuquerque International Sunport at 7:00 AM on Tuesday, August 18 and arrives at Naples.',
      ),
    ).toEqual({ priceUsd: 885, stops: 1, carrier: 'Delta' });
  });

  it('handles nonstop, multi-carrier, and comma prices', () => {
    expect(
      parseResultLabel(
        'From 1,323 US dollars round trip total. Nonstop flight with United and Air Canada. Leaves at noon.',
      ),
    ).toEqual({ priceUsd: 1323, stops: 0, carrier: 'United and Air Canada' });
    expect(
      parseResultLabel(
        'From 896 US dollars round trip total. 2 stops flight with American. Operated by Envoy Air as American Eagle. Leaves at 12:07 PM.',
      ),
    ).toEqual({ priceUsd: 896, stops: 2, carrier: 'American' });
  });

  it('rejects non-result labels', () => {
    expect(parseResultLabel('885 US dollars')).toBeNull();
    expect(parseResultLabel('Track prices from Albuquerque to Naples')).toBeNull();
    expect(parseResultLabel('From 885 US dollars one way total. Nonstop flight.')).toBeNull();
  });
});

describe('representativeDates', () => {
  it('picks the 2nd Saturday and a 7-night stay', () => {
    // Aug 2026: the 1st is a Saturday → 2nd Saturday is the 8th
    expect(representativeDates('2026-08')).toEqual({
      departDate: '2026-08-08',
      returnDate: '2026-08-15',
    });
    // Nov 2026: the 1st is a Sunday → Saturdays are 7,14 → 2nd is the 14th
    expect(representativeDates('2026-11')).toEqual({
      departDate: '2026-11-14',
      returnDate: '2026-11-21',
    });
  });

  it('is deterministic and stays within/adjacent to the month', () => {
    for (const month of ['2026-09', '2026-12', '2027-02']) {
      const a = representativeDates(month);
      expect(a).toEqual(representativeDates(month));
      expect(a.departDate.startsWith(month)).toBe(true);
    }
  });
});
