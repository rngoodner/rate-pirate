import { existsSync } from 'node:fs';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

// Only referenced inside page.evaluate callbacks, which run in the browser;
// the server tsconfig deliberately has no DOM lib.
declare const document: {
  querySelectorAll: (selector: string) => Iterable<{
    getAttribute: (name: string) => string | null;
    textContent: string | null;
    click: () => void;
  }>;
  body: { innerText: string };
};
import { exploreUrl, googleFlightsUrl } from '@rate-pirate/shared';
import type {
  CallLog,
  ExploreDestination,
  ExploreQuery,
  FlightPriceProvider,
  Layover,
  MonthQuery,
  MonthResult,
  PriceInsights,
  RoundTripQuote,
} from './types.js';
import { ProviderError } from './types.js';

/** Scrapes Google Flights result pages with headless Chrome and reads prices
 *  from aria-labels — the most stable surface Google exposes (screen readers
 *  depend on it). One page load per route-month, politely throttled. */

// Inter-request pacing: 2–3.5s (jittered). Empirically tuned — a sustained
// 30-request batch of varied routes held ~93–97% success with zero throttling
// down to ~1s gaps; 2–3.5s keeps a comfortable margin while ~halving batch time
// vs the old 4–7s. Google's throttle responds to sustained daily volume (capped
// by daily_call_budget), not batch burst rate, so pacing is about politeness.
const MIN_CALL_GAP_MS = 2000;
const CALL_JITTER_MS = 1500;
const BROWSER_IDLE_CLOSE_MS = 3 * 60_000;
const RESULT_TIMEOUT_MS = 30_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
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

/** "From 885 US dollars round trip total. 1 stop flight with Delta. Leaves …
 *  Total duration 16 hr 5 min. Layover (1 of 1) is a 3 hr 31 min layover at
 *  Hartsfield-Jackson Atlanta International Airport in Atlanta. …" — the card
 *  aria-label describes the outbound leg's timing, duration, and layovers. */
export function parseResultLabel(
  label: string,
): {
  priceUsd: number;
  stops: number;
  carrier: string;
  durationMinutes: number | null;
  layovers: Layover[];
} | null {
  const price = label.match(/^From ([\d,]+) US dollars round trip total\./);
  if (!price) return null;
  const stops = label.includes('Nonstop flight')
    ? 0
    : Number(label.match(/(\d+) stops? flight/)?.[1] ?? 1);
  const carrier = (label.match(/flight with ([^.]+?)\./)?.[1] ?? '').slice(0, 60);
  const durText = label.match(/Total duration ([^.]+?)\./)?.[1] ?? '';
  const durationMinutes = hoursMinsToMinutes(durText);
  const layovers: Layover[] = [];
  const re = /Layover \([^)]*\) is an? (.+?) layover at .+? in ([^.]+?)\./g;
  for (let m = re.exec(label); m; m = re.exec(label)) {
    layovers.push({ airport: m[2]!.trim().slice(0, 60), minutes: hoursMinsToMinutes(m[1]!) });
  }
  return { priceUsd: Number(price[1]!.replaceAll(',', '')), stops, carrier, durationMinutes, layovers };
}

/** "16 hr 5 min" / "22 hr" / "45 min" / "1 day 4 hr 30 min" / "overnight 9 hr
 *  15 min" → total minutes (null if no day/hour/minute component is present). */
function hoursMinsToMinutes(s: string): number | null {
  const day = Number(s.match(/(\d+)\s*day/)?.[1] ?? 0);
  const hr = Number(s.match(/(\d+)\s*hr/)?.[1] ?? 0);
  const min = Number(s.match(/(\d+)\s*min/)?.[1] ?? 0);
  const total = day * 1440 + hr * 60 + min;
  return total > 0 ? total : null;
}

/** Parse a Google Flights "Explore" RPC response (FlightsFrontendUi/data) into
 *  its ranked destination list. Explore returns structured JSON — robust to
 *  parse — where each destination entry is a positional array: [0]=entity id
 *  "/m/…", [2]=city, [4]=country, [11]=depart, [12]=return, [15]=IATA. Prices
 *  are NOT in this payload (the scanner fetches them per candidate). */
export function parseExploreRpc(raw: string): ExploreDestination[] {
  let body = raw;
  if (body.startsWith(")]}'")) body = body.slice(body.indexOf('\n') + 1);
  const start = body.indexOf('[');
  if (start < 0) return [];
  // Bracket-match the first complete JSON array (batchexecute appends more).
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) return [];
  let payload: unknown;
  try {
    const outer = JSON.parse(body.slice(start, end)) as unknown[];
    const wrb = outer.find(
      (r): r is unknown[] => Array.isArray(r) && r[0] === 'wrb.fr' && typeof r[2] === 'string',
    );
    if (!wrb) return [];
    payload = JSON.parse(wrb[2] as string);
  } catch {
    return [];
  }
  const out: ExploreDestination[] = [];
  const seen = new Set<string>();
  const walk = (x: unknown): void => {
    if (!Array.isArray(x)) return;
    const iata = x[15];
    if (typeof x[0] === 'string' && (x[0] as string).startsWith('/m/') && typeof iata === 'string') {
      if (
        /^[A-Z]{3}$/.test(iata) &&
        !seen.has(iata) &&
        typeof x[11] === 'string' &&
        typeof x[12] === 'string'
      ) {
        seen.add(iata);
        out.push({
          iata,
          city: String(x[2] ?? iata),
          country: String(x[4] ?? ''),
          departDate: x[11] as string,
          returnDate: x[12] as string,
        });
      }
      return; // a destination entry has no nested destinations
    }
    for (const e of x) walk(e);
  };
  walk(payload);
  return out;
}

/** Whole-globe map bounds, as Explore's RPC expects them: [[north, east],
 *  [south, west]]. Explore is a map interface — it only returns destinations
 *  inside the current viewport, which defaults to a REGIONAL (US) window
 *  centered on the origin. Overriding the bounds to the whole world is what
 *  "zooming all the way out" does on the site, and it's the difference between
 *  ~50 US destinations and worldwide coverage. */
const WORLDWIDE_BOUNDS = [
  [85, 180],
  [-85, -180],
];

/** Rewrite an Explore RPC POST body (`f.req=…`) so the search covers the whole
 *  world instead of the default regional viewport. The map bounds live in the
 *  2nd element of the inner request array; the trailing `2` is the "user moved
 *  the map" flag the site adds. Returns the body unchanged if it doesn't parse
 *  (fail safe → regional results rather than a broken request). */
export function withWorldwideBounds(postData: string): string {
  try {
    const params = new URLSearchParams(postData);
    const freq = params.get('f.req');
    if (!freq) return postData;
    const arr = JSON.parse(freq) as [null, string];
    const inner = JSON.parse(arr[1]) as unknown[];
    inner[1] = WORLDWIDE_BOUNDS;
    if (inner.length < 12) inner.push(2);
    arr[1] = JSON.stringify(inner);
    params.set('f.req', JSON.stringify(arr));
    return params.toString();
  } catch {
    return postData;
  }
}

/** "Prices are currently low|typical|high" from the results page body text. */
export function parsePriceLevel(bodyText: string): PriceInsights['level'] {
  const m = bodyText.match(/Prices are currently\s+(low|typical|high)/i);
  return m ? (m[1]!.toLowerCase() as 'low' | 'typical' | 'high') : null;
}

/** Convert the Price-graph bars into a {date, priceCents} series. Each bar's top
 *  pixel is mapped to dollars by a linear fit through the y-axis $ labels (bars
 *  and axis are read from the DOM in the same client-coordinate space). Rounds to
 *  the nearest dollar; drops undated/non-positive bars. Pure so it's unit-tested
 *  without a browser. Returns [] when there aren't enough bars/axis refs. */
export function priceGraphSeries(
  bars: { date: string | null; topY: number }[],
  axis: { dollars: number; y: number }[],
): { date: string; priceCents: number }[] {
  if (bars.length < 6 || axis.length < 2) return [];
  const lo = axis.reduce((p, c) => (c.dollars < p.dollars ? c : p));
  const hi = axis.reduce((p, c) => (c.dollars > p.dollars ? c : p));
  if (hi.y === lo.y) return [];
  const m = (hi.dollars - lo.dollars) / (hi.y - lo.y);
  const b = lo.dollars - m * lo.y;
  return bars
    .filter((bar): bar is { date: string; topY: number } => !!bar.date)
    .map((bar) => ({ date: bar.date, priceCents: Math.round(m * bar.topY + b) * 100 }))
    .filter((p) => p.priceCents > 0);
}

/** Price-history graph bar label: "61 days ago - $494" / "Today - $494".
 *  Returns the absolute 'YYYY-MM-DD' the bar refers to, anchored at `asOf`. */
export function parseHistoryLabel(
  label: string,
  asOf: Date,
): { date: string; priceCents: number } | null {
  const m = label.match(/^(?:(\d+) days? ago|Today) - \$([\d,]+)$/);
  if (!m) return null;
  const daysAgo = m[1] ? Number(m[1]) : 0;
  const date = new Date(asOf.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  return { date, priceCents: Number(m[2]!.replaceAll(',', '')) * 100 };
}

/** Representative round trip for a month: the 2nd `departureDow` weekday
 *  (0=Sun … 6=Sat) of the month, staying `nights` nights. */
export function representativeDates(
  month: string,
  nights = 7,
  departureDow = 6,
): { departDate: string; returnDate: string } {
  const first = new Date(`${month}-01T00:00:00Z`);
  const daysToDow = (departureDow - first.getUTCDay() + 7) % 7;
  const depart = new Date(first.getTime() + (daysToDow + 7) * 86_400_000);
  const ret = new Date(depart.getTime() + nights * 86_400_000);
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
  private launching: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastCallAt = 0;
  private inFlight = 0;
  private throttleChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly chromePath: string,
    private readonly onCall?: (log: CallLog) => void,
    private readonly opts: { noSandbox?: boolean } = {},
  ) {}

  async monthQuotes(q: MonthQuery): Promise<MonthResult> {
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

  private async fetchQuotes(q: MonthQuery): Promise<MonthResult> {
    // Hold the idle-close timer while any fetch is in flight — a timer armed by
    // the previous fetch must not close the browser under this one.
    this.inFlight++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      return await this.fetchQuotesInner(q);
    } finally {
      this.inFlight--;
      this.scheduleIdleClose();
    }
  }

  /** One Explore page load → the ranked destination list (IATA + dates) parsed
   *  from the FlightsFrontendUi RPC response. Prices are fetched separately by
   *  the scanner via `monthQuotes` with the returned exact dates. */
  async exploreSearch(q: ExploreQuery): Promise<ExploreDestination[]> {
    await this.throttle();
    // Hold the idle-close timer for the whole call; pair inFlight++ with the
    // finally so a newPage() throw can't leak the counter (which would pin the
    // browser open forever — scheduleIdleClose early-returns while inFlight>0).
    this.inFlight++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const route = `${q.origin} ${q.tripType} ${q.cabin}`;
    let page: Page | null = null;
    try {
      page = await (await this.getBrowser()).newPage();
      let rpc = '';
      // Rewrite the Explore search request to cover the whole world instead of
      // the default regional viewport (see withWorldwideBounds). Only the first
      // matching request is rewritten; everything else passes through untouched.
      let boundsInjected = false;
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const pd = req.postData();
        if (!boundsInjected && req.method() === 'POST' && /FlightsFrontendUi\/data/.test(req.url()) && pd) {
          boundsInjected = true;
          void req.continue({ postData: withWorldwideBounds(pd) });
          return;
        }
        void req.continue();
      });
      page.on('response', (r) => {
        if (rpc || r.request().method() !== 'POST' || !/FlightsFrontendUi\/data/.test(r.url())) return;
        void r
          .text()
          .then((t) => {
            if (t.length > 20_000 && !rpc) rpc = t;
          })
          .catch(() => {});
      });
      await page.setUserAgent(USER_AGENT);
      await page.setViewport({ width: 1280, height: 1000 });
      await page.goto(exploreUrl(q.origin, q.cabin, q.tripType, q.adults), {
        waitUntil: 'networkidle2',
        timeout: RESULT_TIMEOUT_MS,
      });
      if (page.url().includes('consent.google.com')) {
        throw new ProviderError('google consent wall — needs manual attention');
      }
      // The RPC usually lands during load; give it a moment if not.
      for (let i = 0; i < 20 && !rpc; i++) await new Promise((r) => setTimeout(r, 300));
      // No RPC captured at all → the capture failed (format change, interstitial,
      // block). Surface it as an error rather than a silent empty result, so the
      // scanner logs it and scansBroken can trip.
      if (!rpc) throw new ProviderError(`explore RPC not captured for ${route}`);
      const dests = parseExploreRpc(rpc);
      this.onCall?.({ endpoint: 'explore', route, status: 200, ok: true });
      return dests;
    } catch (err) {
      this.onCall?.({ endpoint: 'explore', route, ok: false });
      throw err instanceof ProviderError ? err : new ProviderError(`explore failed for ${route}: ${err}`);
    } finally {
      if (page) await page.close().catch(() => {});
      this.inFlight--;
      this.scheduleIdleClose();
    }
  }

  private async fetchQuotesInner(q: MonthQuery): Promise<MonthResult> {
    // Exact dates (Explore candidate) take precedence over the month sample.
    const { departDate, returnDate } =
      q.departDate && q.returnDate
        ? { departDate: q.departDate, returnDate: q.returnDate }
        : representativeDates(q.month, q.nights, q.departureDow);
    const route = `${q.origin}-${q.destination} ${q.month} ${q.cabin}`;
    // Deterministic tfs deep link (same builder as the booking links). The old
    // natural-language `q=` form silently failed to parse the "in premium
    // economy" phrase — Google dropped us on the empty search form, so premium
    // economy collected ZERO data. tfs specifies the cabin exactly, no parsing.
    const url = googleFlightsUrl(q.origin, q.destination, departDate, returnDate, q.cabin, q.adults ?? 1);

    await this.throttle();
    const page = await (await this.getBrowser()).newPage();
    try {
      await page.setUserAgent(USER_AGENT);
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
          durationMinutes: parsed.durationMinutes,
          layovers: parsed.layovers,
        });
        if (quotes.length >= MAX_QUOTES) break;
      }

      this.onCall?.({ endpoint: 'flights-page', route, status: 200, ok: true });
      // Insights are best-effort extras on the same page — never fail the scan.
      const insights = await this.collectInsights(page, bodyText, q.wantHistory ?? false).catch(
        () => null,
      );
      return { quotes: quotes.sort((a, b) => a.priceCents - b.priceCents), insights };
    } catch (err) {
      if (err instanceof ProviderError || err instanceof TransientPageError) throw err;
      this.onCall?.({ endpoint: 'flights-page', route, ok: false });
      throw new ProviderError(`google-flights failed for ${route}: ${err}`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Google's price-level verdict (free, from body text) and, when asked, the
   *  ~60-day history graph behind one "View price history" click. Best-effort:
   *  any failure degrades to partial/null insights, never a scan error. */
  private async collectInsights(
    page: Page,
    bodyText: string,
    wantHistory: boolean,
  ): Promise<PriceInsights | null> {
    const level = parsePriceLevel(bodyText);
    if (!wantHistory) return level ? { level, history: null } : null;

    const clicked = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('button, [role="button"], span, div')];
      const el = nodes.find((n) => n.textContent?.trim() === 'View price history');
      if (!el) return false;
      el.click();
      return true;
    });
    // No price-history graph on this page — premium economy never has one. Fall
    // back to the Price graph (fare across departure dates), whose median is a
    // valid baseline. See collectPriceGraph.
    if (!clicked) {
      const priceGraph = await this.collectPriceGraph(page).catch(() => null);
      return { level, history: null, priceGraph };
    }

    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('[aria-label]')].some((el) =>
            /days ago - \$/.test(el.getAttribute('aria-label') ?? ''),
          ),
        { timeout: 8000 },
      )
      .catch(() => {});

    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('[aria-label]')]
        .map((el) => el.getAttribute('aria-label')!)
        .filter((l) => /^(?:\d+ days? ago|Today) - \$[\d,]+$/.test(l)),
    );
    const asOf = new Date();
    const history = labels
      .map((l) => parseHistoryLabel(l, asOf))
      .filter((p): p is { date: string; priceCents: number } => p !== null)
      .sort((a, b) => a.date.localeCompare(b.date));
    // A thin series isn't a baseline — require a meaningful window. When history
    // is too thin, fall back to the Price graph, same as the no-history case.
    if (history.length >= 10) return { level, history };
    const priceGraph = await this.collectPriceGraph(page).catch(() => null);
    return { level, history: null, priceGraph };
  }

  /** Google's "Price graph" (fare across departure dates) — the fallback baseline
   *  source for cabins Google doesn't give a 60-day price *history* for (premium
   *  economy). Returns the bar distribution as a {date, priceCents}[] series (date
   *  = each bar's departure date), or null. Its median stands in for the history
   *  median in computeBaseline.
   *
   *  The graph is an in-page panel (no extra page load): each bar is an SVG
   *  `<path data-id="YYYY-MM-DD" data-rect="x,baseline,w,height">`, and the y-axis
   *  is a set of `<tspan>$N</tspan>` labels. We linearly map a bar's top pixel to
   *  dollars via the axis labels — validated live: the searched date's computed
   *  price matched Google's shown price to ~0.3%. */
  private async collectPriceGraph(page: Page): Promise<{ date: string; priceCents: number }[] | null> {
    // Open the Price graph. Use an ElementHandle click (not a viewport-coordinate
    // click): it scrolls the control into view first, so it still works when the
    // button sits below the fold on a taller results page. A plain DOM el.click()
    // on the wrapper doesn't open the panel — the handle click is a real click.
    const handle = await page.evaluateHandle(
      () =>
        [...document.querySelectorAll('button, [role="button"], a')].find(
          (n) => n.textContent?.trim() === 'Price graph',
        ) ?? null,
    );
    const btn = handle.asElement();
    if (!btn) {
      await handle.dispose();
      return null;
    }
    await btn.click();
    await handle.dispose();
    // Wait for both the bars AND the y-axis $ labels — the geometry read needs
    // both, and they render a beat apart. Then a short settle so getBoundingClient-
    // Rect returns final laid-out positions.
    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('path[data-id][data-rect]')].length > 5 &&
          [...document.querySelectorAll('tspan')].filter((t) =>
            /^\$[\d,]+$/.test(t.textContent?.trim() ?? ''),
          ).length >= 2,
        { timeout: 8000 },
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 400));

    // Gather raw geometry in the page; do the pixel→dollar math in Node (pure,
    // unit-tested) via priceGraphSeries.
    const raw = await page.evaluate(() => ({
      bars: [...document.querySelectorAll('path[data-id][data-rect]')].map((el) => ({
        date: el.getAttribute('data-id'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DOM geometry, no dom lib in server tsconfig
        topY: (el as any).getBoundingClientRect().top as number,
      })),
      axis: [...document.querySelectorAll('tspan')]
        .map((t) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DOM geometry, no dom lib in server tsconfig
          const r = (t as any).getBoundingClientRect();
          return { txt: t.textContent?.trim() ?? '', y: r.top + r.height / 2 };
        })
        .filter((a) => /^\$[\d,]+$/.test(a.txt))
        .map((a) => ({ dollars: Number(a.txt.replace(/[$,]/g, '')), y: a.y })),
    }));
    const series = priceGraphSeries(raw.bars, raw.axis);
    // A thin series isn't a baseline, same threshold as the history path.
    return series.length >= 10 ? series : null;
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }

  /** Memoized launch: concurrent callers share one in-flight launch instead of
   *  racing check-then-launch and orphaning a Chromium process. */
  private async getBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    this.launching ??= puppeteer
      .launch({
        executablePath: this.chromePath,
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--lang=en-US',
          // Chromium's /dev/shm usage is the classic headless-on-Debian crash
          // when shm is small; use /tmp-backed shared memory instead.
          '--disable-dev-shm-usage',
          // Sandboxed by default; CHROME_NO_SANDBOX=true is the escape hatch.
          ...(this.opts.noSandbox ? ['--no-sandbox'] : []),
        ],
      })
      .then((b) => {
        this.browser = b;
        return b;
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  private scheduleIdleClose(): void {
    if (this.inFlight > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), BROWSER_IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  /** Promise-chain queue: concurrent callers are strictly sequenced so the
   *  pacing gap to Google holds even if two scans ever overlap. */
  private throttle(): Promise<void> {
    const turn = this.throttleChain.then(async () => {
      const gap = MIN_CALL_GAP_MS + Math.random() * CALL_JITTER_MS;
      const wait = this.lastCallAt + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCallAt = Date.now();
    });
    this.throttleChain = turn;
    return turn;
  }
}
