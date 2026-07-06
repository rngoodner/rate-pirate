import { existsSync } from 'node:fs';
import puppeteer, { type Browser } from 'puppeteer-core';

// Only referenced inside page.evaluate callbacks, which run in the browser;
// the server tsconfig deliberately has no DOM lib.
declare const document: {
  querySelectorAll: (selector: string) => Iterable<{ getAttribute: (name: string) => string | null }>;
  body: { innerText: string };
};
import { CABIN_QUERY_PHRASE } from '@rate-pirate/shared';
import type { FlightPriceProvider, MonthQuery, RoundTripQuote } from './types.js';
import { ProviderError } from './types.js';
import type { CallLog } from './travelpayouts.js';

/** Scrapes Google Flights result pages with headless Chrome and reads prices
 *  from aria-labels — the most stable surface Google exposes (screen readers
 *  depend on it). One page load per route-month, politely throttled. */

const MIN_CALL_GAP_MS = 4000;
const CALL_JITTER_MS = 3000;
const BROWSER_IDLE_CLOSE_MS = 3 * 60_000;
const RESULT_TIMEOUT_MS = 30_000;
const MAX_QUOTES = 5;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS
  '/usr/bin/chromium', // Debian
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
];

export function findChrome(configured?: string): string {
  for (const path of [configured, ...CHROME_CANDIDATES]) {
    if (path && existsSync(path)) return path;
  }
  throw new Error(
    'No Chrome/Chromium found. Install it (Debian: apt install chromium) or set CHROME_PATH.',
  );
}

/** "From 885 US dollars round trip total. 1 stop flight with Delta. Leaves …" */
export function parseResultLabel(
  label: string,
): { priceUsd: number; stops: number; carrier: string } | null {
  const price = label.match(/^From ([\d,]+) US dollars round trip total\./);
  if (!price) return null;
  const stops = label.includes('Nonstop flight')
    ? 0
    : Number(label.match(/(\d+) stops? flight/)?.[1] ?? 1);
  const carrier = (label.match(/flight with ([^.]+?)\./)?.[1] ?? '').slice(0, 60);
  return { priceUsd: Number(price[1]!.replaceAll(',', '')), stops, carrier };
}

/** Representative round trip for a month: 2nd Saturday departure, 7 nights. */
export function representativeDates(month: string): { departDate: string; returnDate: string } {
  const first = new Date(`${month}-01T00:00:00Z`);
  const daysToSaturday = (6 - first.getUTCDay() + 7) % 7;
  const depart = new Date(first.getTime() + (daysToSaturday + 7) * 86_400_000);
  const ret = new Date(depart.getTime() + 7 * 86_400_000);
  return {
    departDate: depart.toISOString().slice(0, 10),
    returnDate: ret.toISOString().slice(0, 10),
  };
}

/** "Oops, something went wrong" — Google's transient failure page. */
class TransientPageError extends ProviderError {
  constructor(route: string) {
    super(`google-flights transient error for ${route}`);
    this.name = 'TransientPageError';
  }
}

export class GoogleFlightsProvider implements FlightPriceProvider {
  readonly name = 'google-flights';
  private browser: Browser | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastCallAt = 0;

  constructor(
    private readonly chromePath: string,
    private readonly onCall?: (log: CallLog) => void,
  ) {}

  async monthQuotes(q: MonthQuery): Promise<RoundTripQuote[]> {
    // Google intermittently answers "Oops, something went wrong" — retry once.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.fetchQuotes(q);
      } catch (err) {
        if (attempt > 0 || !(err instanceof TransientPageError)) throw err;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async fetchQuotes(q: MonthQuery): Promise<RoundTripQuote[]> {
    const { departDate, returnDate } = representativeDates(q.month);
    const route = `${q.origin}-${q.destination} ${q.month} ${q.cabin}`;
    // Economy keeps the exact query proven to work; premium cabins append the
    // cabin phrase Google's natural-language search understands.
    const phrase = CABIN_QUERY_PHRASE[q.cabin];
    const query =
      `Flights from ${q.origin} to ${q.destination} on ${departDate} through ${returnDate}` +
      (phrase ? ` ${phrase}` : '');
    const url = `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}&hl=en&curr=USD`;

    await this.throttle();
    const page = await (await this.getBrowser()).newPage();
    try {
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      );
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: RESULT_TIMEOUT_MS });

      if (page.url().includes('consent.google.com')) {
        this.onCall?.({ endpoint: 'flights-page', route, ok: false });
        throw new ProviderError('google consent wall — needs manual attention');
      }

      // Results render asynchronously; either prices or a no-results notice appears.
      await page
        .waitForFunction(
          () =>
            /\$\d/.test(document.body.innerText) ||
            /no results|No flights/i.test(document.body.innerText),
          { timeout: RESULT_TIMEOUT_MS },
        )
        .catch(() => {});

      const bodyText = await page.evaluate(() => document.body.innerText);
      if (/Oops, something went wrong/i.test(bodyText)) {
        this.onCall?.({ endpoint: 'flights-page', route, ok: false });
        throw new TransientPageError(route);
      }

      const labels = await page.evaluate(() =>
        [...document.querySelectorAll('[aria-label]')]
          .map((el) => el.getAttribute('aria-label')!)
          .filter((l) => l.startsWith('From ') && l.includes('round trip total')),
      );

      const seen = new Set<string>();
      const quotes: RoundTripQuote[] = [];
      for (const label of labels) {
        if (seen.has(label)) continue;
        seen.add(label);
        const parsed = parseResultLabel(label);
        if (!parsed) continue;
        quotes.push({
          origin: q.origin,
          destination: q.destination,
          cabin: q.cabin,
          departDate,
          returnDate,
          priceCents: parsed.priceUsd * 100,
          currency: 'USD',
          stops: parsed.stops,
          carrier: parsed.carrier,
        });
        if (quotes.length >= MAX_QUOTES) break;
      }

      this.onCall?.({ endpoint: 'flights-page', route, status: 200, ok: true });
      return quotes.sort((a, b) => a.priceCents - b.priceCents);
    } catch (err) {
      if (err instanceof ProviderError || err instanceof TransientPageError) throw err;
      this.onCall?.({ endpoint: 'flights-page', route, ok: false });
      throw new ProviderError(`google-flights failed for ${route}: ${err}`);
    } finally {
      await page.close().catch(() => {});
      this.scheduleIdleClose();
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    this.browser = await puppeteer.launch({
      executablePath: this.chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=en-US'],
    });
    return this.browser;
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), BROWSER_IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  private async throttle(): Promise<void> {
    const gap = MIN_CALL_GAP_MS + Math.random() * CALL_JITTER_MS;
    const wait = this.lastCallAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }
}
