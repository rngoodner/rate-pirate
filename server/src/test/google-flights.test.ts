import { describe, expect, it } from 'vitest';
import {
  GoogleFlightsProvider,
  parseExploreRpc,
  parseHistoryLabel,
  parsePriceLevel,
  parseResultLabel,
  priceGraphSeries,
  representativeDates,
  withWorldwideBounds,
} from '../providers/google-flights.js';
import { ProviderError } from '../providers/types.js';
import type { ExploreDestination, ExploreQuery } from '../providers/types.js';

describe('parseExploreRpc', () => {
  // Minimal fixture matching the real batchexecute envelope: )]}' prefix, a
  // length line, then [["wrb.fr", null, "<json payload string>", …]]. Each
  // destination is a positional array: [0]="/m/…", [2]=city, [4]=country,
  // [11]=depart, [12]=return, [15]=IATA.
  function envelope(payload: unknown): string {
    const inner = JSON.stringify(payload);
    const outer = JSON.stringify([['wrb.fr', null, inner, null, null, null, 'generic']]);
    return `)]}'\n\n${outer.length}\n${outer}`;
  }
  const dest = (mid: string, city: string, country: string, dep: string, ret: string, iata: string) =>
    [mid, [1, 2], city, 'img', country, 1, 2, 'img', null, null, null, dep, ret, null, false, iata];

  it('parses destinations (iata, city, country, dates) from the RPC envelope', () => {
    const raw = envelope([null, null, null, [[dest('/m/0cv3w', 'Las Vegas', 'United States', '2026-08-06', '2026-08-12', 'LAS'), dest('/m/04jpl', 'London', 'United Kingdom', '2026-09-05', '2026-09-12', 'LON')]]]);
    const out = parseExploreRpc(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ iata: 'LAS', city: 'Las Vegas', country: 'United States', departDate: '2026-08-06', returnDate: '2026-08-12' });
    expect(out[1]!.iata).toBe('LON');
  });

  it('skips entries without a valid IATA and dedupes; tolerates junk', () => {
    const raw = envelope([[[dest('/m/x', 'Zion', 'United States', '2026-08-06', '2026-08-12', 'Zion National Park'), dest('/m/y', 'Cancún', 'Mexico', '2026-08-06', '2026-08-12', 'CUN'), dest('/m/z', 'Cancún', 'Mexico', '2026-08-06', '2026-08-12', 'CUN')]]]);
    const out = parseExploreRpc(raw);
    expect(out.map((d) => d.iata)).toEqual(['CUN']); // non-IATA skipped, dupe removed
    expect(parseExploreRpc('not json at all')).toEqual([]);
    expect(parseExploreRpc('')).toEqual([]);
  });
});

describe('googleFlightsUrl (tfs deep link)', () => {
  it('encodes route/dates/cabin into the exact live-verified tfs payloads', async () => {
    const { googleFlightsUrl } = await import('@rate-pirate/shared');
    // These three URLs were loaded against real Google Flights: route, dates,
    // and cabin all populate (no "Where to?" blank form), priced results render.
    expect(googleFlightsUrl('ABQ', 'CUN', '2026-09-12', '2026-09-19', 'economy')).toBe(
      'https://www.google.com/travel/flights?tfs=GhoSCjIwMjYtMDktMTJqBRIDQUJRcgUSA0NVThoaEgoyMDI2LTA5LTE5agUSA0NVTnIFEgNBQlFAAUgBmAEB&hl=en&curr=USD',
    );
    expect(googleFlightsUrl('ABQ', 'NAP', '2026-09-12', '2026-09-19', 'business')).toBe(
      'https://www.google.com/travel/flights?tfs=GhoSCjIwMjYtMDktMTJqBRIDQUJRcgUSA05BUBoaEgoyMDI2LTA5LTE5agUSA05BUHIFEgNBQlFAAUgDmAEB&hl=en&curr=USD',
    );
    expect(googleFlightsUrl('ABQ', 'SEA', '2026-09-12', '2026-09-19', 'premium_economy')).toBe(
      'https://www.google.com/travel/flights?tfs=GhoSCjIwMjYtMDktMTJqBRIDQUJRcgUSA1NFQRoaEgoyMDI2LTA5LTE5agUSA1NFQXIFEgNBQlFAAUgCmAEB&hl=en&curr=USD',
    );
  });

  it('defaults to 1 adult (byte-identical) but encodes larger party sizes', async () => {
    const { googleFlightsUrl } = await import('@rate-pirate/shared');
    const one = googleFlightsUrl('ABQ', 'CUN', '2026-09-12', '2026-09-19', 'economy');
    expect(googleFlightsUrl('ABQ', 'CUN', '2026-09-12', '2026-09-19', 'economy', 1)).toBe(one);
    // A different party size must produce a different (adult-count) payload.
    expect(googleFlightsUrl('ABQ', 'CUN', '2026-09-12', '2026-09-19', 'economy', 3)).not.toBe(one);
  });
});

describe('withWorldwideBounds', () => {
  const bodyFor = (inner: unknown[]) =>
    'f.req=' + encodeURIComponent(JSON.stringify([null, JSON.stringify(inner)])) + '&at=token123';

  it('injects whole-globe map bounds into the Explore request (2nd field) + move flag', () => {
    // The default request has no bounds and 11 elements.
    const inner = [[], null, null, [['ABQ']], null, 1, null, 0, null, 1, [964, 920]];
    const params = new URLSearchParams(withWorldwideBounds(bodyFor(inner)));
    const outInner = JSON.parse(JSON.parse(params.get('f.req')!)[1]) as unknown[];
    expect(outInner[1]).toEqual([
      [85, 180],
      [-85, -180],
    ]);
    expect(outInner[outInner.length - 1]).toBe(2); // "user moved the map" flag
    expect(params.get('at')).toBe('token123'); // session token untouched
  });

  it('returns the body unchanged when there is no f.req or it does not parse', () => {
    expect(withWorldwideBounds('garbage=1')).toBe('garbage=1');
    expect(withWorldwideBounds('f.req=not-json&at=x')).toBe('f.req=not-json&at=x');
  });
});

describe('parsePriceLevel', () => {
  it('reads the level verdict from body text', () => {
    expect(parsePriceLevel('… Price insights Prices are currently typical View price history …')).toBe('typical');
    expect(parsePriceLevel('Prices are currently  low')).toBe('low');
    expect(parsePriceLevel('Prices are currently high for this search')).toBe('high');
  });

  it('returns null when the block is absent or unrecognized', () => {
    expect(parsePriceLevel('no insights on this page')).toBeNull();
    expect(parsePriceLevel('Prices are currently unavailable')).toBeNull();
  });
});

describe('parseHistoryLabel', () => {
  const asOf = new Date('2026-07-06T05:00:00Z');

  it('parses graph bar labels into dated prices (live format: "61 days ago - $494")', () => {
    expect(parseHistoryLabel('61 days ago - $494', asOf)).toEqual({
      date: '2026-05-06',
      priceCents: 49400,
    });
    expect(parseHistoryLabel('1 day ago - $1,204', asOf)).toEqual({
      date: '2026-07-05',
      priceCents: 120400,
    });
    expect(parseHistoryLabel('Today - $494', asOf)).toEqual({
      date: '2026-07-06',
      priceCents: 49400,
    });
  });

  it('rejects labels that are not graph bars', () => {
    expect(parseHistoryLabel('From 885 US dollars round trip total.', asOf)).toBeNull();
    expect(parseHistoryLabel('61 days ago', asOf)).toBeNull();
    expect(parseHistoryLabel('$494', asOf)).toBeNull();
  });
});

describe('exploreSearch retry', () => {
  const q: ExploreQuery = { origin: 'ABQ', cabin: 'economy', tripType: 'weekend', adults: 1 };
  const dest: ExploreDestination = {
    iata: 'LHR', city: 'London', country: 'United Kingdom', departDate: '2026-08-21', returnDate: '2026-08-24',
  };
  // Stub the private per-attempt method so the retry loop runs without a browser.
  const stub = (p: GoogleFlightsProvider, fn: () => Promise<ExploreDestination[]>) => {
    (p as unknown as { exploreSearchOnce: () => Promise<ExploreDestination[]> }).exploreSearchOnce = fn;
  };

  it('retries a transient RPC-capture failure and succeeds on a later attempt', async () => {
    const p = new GoogleFlightsProvider('/no/chrome');
    let calls = 0;
    stub(p, async () => {
      calls++;
      if (calls < 2) throw new ProviderError('explore RPC not captured for ABQ weekend economy');
      return [dest];
    });
    expect(await p.exploreSearch(q)).toEqual([dest]);
    expect(calls).toBe(2);
  });

  it('gives up after the attempt cap and rethrows the last error', async () => {
    const p = new GoogleFlightsProvider('/no/chrome');
    let calls = 0;
    stub(p, async () => {
      calls++;
      throw new ProviderError('explore RPC not captured');
    });
    await expect(p.exploreSearch(q)).rejects.toThrow('RPC not captured');
    expect(calls).toBe(3); // EXPLORE_ATTEMPTS
  });

  it('does not retry a consent wall — it needs manual attention', async () => {
    const p = new GoogleFlightsProvider('/no/chrome');
    let calls = 0;
    stub(p, async () => {
      calls++;
      throw new ProviderError('google consent wall — needs manual attention');
    });
    await expect(p.exploreSearch(q)).rejects.toThrow('consent wall');
    expect(calls).toBe(1);
  });
});

describe('priceGraphSeries', () => {
  // Real y-axis geometry captured live from an ABQ→LHR premium-economy graph
  // (viewport height 900): $ labels are evenly spaced, ~98px per $1,250.
  const axis = [
    { dollars: 3750, y: 351.34 },
    { dollars: 2500, y: 449.34 },
    { dollars: 1250, y: 547.34 },
    { dollars: 0, y: 645.34 },
  ];

  it('maps bar top pixels to dollars via the axis and drops the $0 baseline bar', () => {
    const bars = [
      { date: '2026-08-21', topY: 449.34 }, // aligns with the $2,500 gridline
      { date: '2026-08-22', topY: 547.34 }, // $1,250
      { date: '2026-08-23', topY: 645.34 }, // $0 → dropped
      { date: '2026-08-24', topY: 449.34 },
      { date: '2026-08-25', topY: 547.34 },
      { date: '2026-08-26', topY: 449.34 },
      { date: null, topY: 449.34 }, // undated → dropped
    ];
    expect(priceGraphSeries(bars, axis)).toEqual([
      { date: '2026-08-21', priceCents: 2500_00 },
      { date: '2026-08-22', priceCents: 1250_00 },
      { date: '2026-08-24', priceCents: 2500_00 },
      { date: '2026-08-25', priceCents: 1250_00 },
      { date: '2026-08-26', priceCents: 2500_00 },
    ]);
  });

  it('recovers the real searched-date price to within rounding', () => {
    // The live run showed Aug 21 ≈ $2,304; its bar top sits ~180.6px above the
    // $0 baseline (2304 / 12.755 $/px). Computed price should land within ~$10.
    const topY = 645.34 - 2304 / 12.755;
    const [pt] = priceGraphSeries([...Array(6)].map((_, i) => ({ date: `2026-08-${21 + i}`, topY })), axis);
    expect(Math.abs(pt!.priceCents / 100 - 2304)).toBeLessThanOrEqual(10);
  });

  it('returns [] without enough bars or axis references', () => {
    expect(priceGraphSeries([{ date: '2026-08-21', topY: 449 }], axis)).toEqual([]);
    const sixBars = [...Array(6)].map((_, i) => ({ date: `2026-08-2${i}`, topY: 449 }));
    expect(priceGraphSeries(sixBars, [{ dollars: 2500, y: 449 }])).toEqual([]);
  });
});

describe('parseResultLabel', () => {
  it('parses price, stops, and carrier from a result aria-label', () => {
    expect(
      parseResultLabel(
        'From 885 US dollars round trip total. 1 stop flight with Delta. Leaves Albuquerque International Sunport at 7:00 AM on Tuesday, August 18 and arrives at Naples.',
      ),
    ).toEqual({ priceUsd: 885, stops: 1, carrier: 'Delta', durationMinutes: null, layovers: [] });
  });

  it('parses duration and layovers from a full (live-format) label', () => {
    // Exactly the shape a real Google Flights result card emits.
    expect(
      parseResultLabel(
        'From 1199 US dollars round trip total. 1 stop flight with Delta. Leaves Albuquerque International Sunport at 7:00 AM on Saturday, September 12 and arrives at Naples International Airport at 7:05 AM on Sunday, September 13. Total duration 16 hr 5 min.  Layover (1 of 1) is a 3 hr 31 min layover at Hartsfield-Jackson Atlanta International Airport in Atlanta. Select flight',
      ),
    ).toEqual({
      priceUsd: 1199,
      stops: 1,
      carrier: 'Delta',
      durationMinutes: 965,
      layovers: [{ airport: 'Atlanta', minutes: 211 }],
    });
  });

  it('parses multiple layovers, including an "overnight" one', () => {
    const parsed = parseResultLabel(
      'From 1450 US dollars round trip total. 2 stops flight with United. Leaves ABQ. Total duration 22 hr. Layover (1 of 2) is a 1 hr 30 min layover at Denver International Airport in Denver. Layover (2 of 2) is an overnight 9 hr 15 min layover at Frankfurt Airport in Frankfurt. Select flight',
    );
    expect(parsed).toEqual({
      priceUsd: 1450,
      stops: 2,
      carrier: 'United',
      durationMinutes: 1320,
      layovers: [
        { airport: 'Denver', minutes: 90 },
        { airport: 'Frankfurt', minutes: 555 },
      ],
    });
  });

  it('counts a "day" component in total duration', () => {
    const p = parseResultLabel(
      'From 1500 US dollars round trip total. 1 stop flight with United. Total duration 1 day 4 hr 30 min. Layover (1 of 1) is a 2 hr layover at Denver International Airport in Denver. Select flight',
    );
    expect(p?.durationMinutes).toBe(1710); // 1440 + 240 + 30
    expect(p?.layovers).toEqual([{ airport: 'Denver', minutes: 120 }]);
  });

  it('handles nonstop, multi-carrier, and comma prices', () => {
    expect(
      parseResultLabel(
        'From 1,323 US dollars round trip total. Nonstop flight with United and Air Canada. Leaves at noon.',
      ),
    ).toEqual({
      priceUsd: 1323,
      stops: 0,
      carrier: 'United and Air Canada',
      durationMinutes: null,
      layovers: [],
    });
    expect(
      parseResultLabel(
        'From 896 US dollars round trip total. 2 stops flight with American. Operated by Envoy Air as American Eagle. Leaves at 12:07 PM.',
      ),
    ).toEqual({
      priceUsd: 896,
      stops: 2,
      carrier: 'American',
      durationMinutes: null,
      layovers: [],
    });
  });

  it('rejects non-result labels', () => {
    expect(parseResultLabel('885 US dollars')).toBeNull();
    expect(parseResultLabel('Track prices from Albuquerque to Naples')).toBeNull();
    expect(parseResultLabel('From 885 US dollars one way total. Nonstop flight.')).toBeNull();
  });
});

describe('representativeDates', () => {
  it('picks the 2nd Saturday and a 7-night stay by default', () => {
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

  it('honors custom nights and departure weekday', () => {
    // 2nd Wednesday (dow 3) of Aug 2026 (1st = Sat): Wednesdays 5,12 → 12th; 10 nights
    expect(representativeDates('2026-08', 10, 3)).toEqual({
      departDate: '2026-08-12',
      returnDate: '2026-08-22',
    });
    // 2nd Friday (dow 5) of Nov 2026 (1st = Sun): Fridays 6,13 → 13th; 3 nights
    expect(representativeDates('2026-11', 3, 5)).toEqual({
      departDate: '2026-11-13',
      returnDate: '2026-11-16',
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
