# Rate Pirate — Software Design Document

_Last updated: 2026-07-05_

## 1. Overview

Rate Pirate is a single-user, mobile-first web app that monitors round-trip flight prices from a home airport (default **ABQ**, Albuquerque International Sunport) to destinations worldwide. When a price falls far below the historical norm for a route, it emails the user. The name and UI are a play on the RatePunk app; reference screenshots live in `ui-samples/`.

**Explicit non-goal: booking.** The app finds deals and tells the user where to purchase — every alert email and date-option row carries a Google Flights deep link pre-filled with route and dates. The user books there. The flight-data provider is used purely as a price-monitoring source; its quotes are indicative, which is fine since we never sell or book.

### Decisions (settled)

| Concern | Decision |
|---|---|
| Language | TypeScript everywhere |
| Flight data | **Google Flights via headless Chrome** (free, real-time, full ABQ coverage). Amadeus was the original pick (self-service portal decommissioned 2026-07-17); Travelpayouts was the first replacement but a coverage probe found ~2% of ABQ route-months in its cache (vs 67% for LAX) and it was removed. `mock` is the only other provider — synthetic data for demos/tests. |
| Email | Resend |
| Users | Single user, no auth; settings editable in UI |
| Booking | None — link out to Google Flights |
| Dev host | macOS localhost |
| Prod host | Debian 12 at `your-server.local`, app in `/opt/rate-pirate` |
| Exposure | nginx on a dedicated free port (e.g. **8081**) → proxy to app on **3789** (ports 80/8080/32400 are taken) |

## 2. Architecture

One Node process: **Hono** serves the JSON API and the built static frontend on port **3789**; **better-sqlite3** for storage (single DB file); **node-cron** drives the scanner; frontend is **React + Vite + Tailwind**, PWA-lite (manifest + icons, no service worker in v1). npm workspaces: `shared/` (wire types), `server/`, `web/`, plus `deploy/`.

**Data-source note:** The primary provider (`providers/google-flights.ts`) drives **headless Chrome (puppeteer-core)** to a Google Flights results page — one page load per route-month, using a representative date pair (2nd Saturday, 7 nights) — and reads prices/stops/carrier from the results' **aria-labels** (`"From 885 US dollars round trip total. 1 stop flight with Delta. …"`), the most stable surface Google exposes since screen readers depend on it. Politeness: 4–7s jittered gaps between loads, modest daily budget (default 100), browser closed after 3 idle minutes. Google's transient "Oops, something went wrong" page is detected and retried once. Chrome/Chromium path auto-detected (macOS app / Debian `apt install chromium`), overridable via `CHROME_PATH`. The provider sits behind a swappable interface with a synthetic mock implementation (`PROVIDER=mock`) so development, tests, and demos never depend on the network.

### Repository layout

```
rate-pirate/
├── package.json                  # npm workspaces: shared, server, web; root scripts
├── tsconfig.base.json
├── .env.example                  # documented env vars, never real keys
├── shared/src/types.ts           # Deal, DealDateOption, Settings, ScanStatus — API wire types
├── server/
│   ├── src/
│   │   ├── index.ts              # entry: config → db → cron → Hono listen
│   │   ├── config.ts             # zod-validated env (token, port, db path, PROVIDER)
│   │   ├── app.ts                # Hono assembly: /api routes + static serve of web/dist
│   │   ├── db/                   # db.ts (WAL, migrations), migrations/001_init.sql,
│   │   │                         # settings.ts (DB → env → default), repo.ts (all queries)
│   │   ├── providers/            # types.ts (interface), google-flights.ts, mock.ts
│   │   ├── scanner/              # destinations.ts, planner.ts, scan.ts, quota.ts, scheduler.ts
│   │   ├── deals/                # baseline.ts, score.ts, detect.ts   (pure logic)
│   │   ├── alerts/               # email.ts (Resend), template.ts, notify.ts (cooldown)
│   │   ├── api/routes.ts
│   │   └── test/                 # unit tests + simulate.ts (fast-forward simulator)
│   └── scripts/                  # record-fixtures.ts (one-off live capture), seed-history.ts
├── web/src/
│   ├── pages/                    # DealsFeed.tsx, DealDetail.tsx, Settings.tsx
│   ├── components/               # DealCard, ScoreBadge, PriceTag, DateOptionRow, TabBar,
│   │                             # Header, StatusBanner, EmptyState
│   └── api/client.ts             # typed fetch wrappers over shared types
└── deploy/                       # rate-pirate.service, nginx.conf, deploy.sh
```

**Module boundary rule:** `deals/` and `alerts/` operate only on repo data and never import `providers/`; `scanner/` is the sole consumer of `providers/`; `api/` reads via `repo.ts`. Everything below the provider seam is unit-testable without network.

## 3. Data model (SQLite)

```sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,   -- home_airport, alert_email, alert_threshold,
  value TEXT NOT NULL       -- daily_call_budget, scan_enabled
);

CREATE TABLE destinations (
  iata    TEXT PRIMARY KEY,             -- 'NAP'
  city    TEXT NOT NULL,
  country TEXT NOT NULL,
  region  TEXT NOT NULL,                -- europe|asia|americas|oceania|domestic|...
  tier    INTEGER NOT NULL DEFAULT 2,   -- 1 scan often, 2 normal, 3 occasional
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE price_snapshots (
  id           INTEGER PRIMARY KEY,
  origin       TEXT NOT NULL,           -- 'ABQ'
  destination  TEXT NOT NULL,
  cabin        TEXT NOT NULL,           -- economy | premium_economy | business | first
  travel_month TEXT NOT NULL,           -- 'YYYY-MM' departure bucket
  depart_date  TEXT NOT NULL,
  return_date  TEXT NOT NULL,
  price_cents  INTEGER NOT NULL,        -- cheapest round-trip found, USD cents
  stops        INTEGER,
  carrier      TEXT,
  source       TEXT NOT NULL,           -- google-flights | mock
  captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_snap_cabin ON price_snapshots(source, origin, destination, travel_month, cabin, captured_at);

CREATE TABLE deals (              -- UNIQUE(source, origin, destination, cabin, travel_month)
  id INTEGER PRIMARY KEY, cabin TEXT NOT NULL,
  origin TEXT NOT NULL, destination TEXT NOT NULL, travel_month TEXT NOT NULL,
  best_price_cents INTEGER NOT NULL, baseline_price_cents INTEGER NOT NULL,
  discount_pct REAL NOT NULL, score INTEGER NOT NULL,      -- 0–100
  depart_date TEXT NOT NULL, return_date TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',                    -- active | expired
  UNIQUE(origin, destination, travel_month)
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  sent_to TEXT NOT NULL, price_cents INTEGER NOT NULL, score INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE api_calls (                 -- quota accounting + debugging
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL, endpoint TEXT NOT NULL, route TEXT,
  status INTEGER, ok INTEGER NOT NULL,
  called_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Baselines are computed in TypeScript (median), not stored. Snapshots pruned after 180 days; api_calls after 60.

## 4. Provider seam

```ts
interface RoundTripQuote {
  origin: string; destination: string;
  departDate: string; returnDate: string;
  priceCents: number; currency: 'USD';
  stops: number; carrier: string;
}
interface FlightPriceProvider {
  readonly name: string;   // recorded as snapshot source
  /** Cheapest cached round-trip quotes for a route + departure month ('YYYY-MM').
   *  One provider call per route-month; may return several date pairs, or [] when
   *  the cache has nothing for the route. */
  monthQuotes(q: { origin: string; destination: string;
    month: string }): Promise<RoundTripQuote[]>;
}
```

- **mock.ts** (`SyntheticProvider`) — deterministic seeded synthetic prices (per-route base × cabin factor × seasonal curve × noise + injectable deal drops) so the simulator and demo seed can fast-forward months of history in milliseconds. Same seed + date + cabin → same quotes.
- Selection via `PROVIDER=google-flights|mock`; defaults to mock. See §9 for how demo (mock) and live (google-flights) data are kept fully separate.

## 5. Scanning & quota strategy

- **Unit of work = route-month-cabin.** One page load returns quotes for a destination + departure month + **cabin** (economy / premium_economy / business / first). The scan universe is destinations × months (+1..+6) × the user's `monitoredCabins`; snapshots, baselines, and deals are all keyed by cabin so a Business deal is scored only against Business history. Only selected cabins are ever loaded, so monitoring more cabins multiplies the work and slows each cabin's refresh cadence proportionally (surfaced to the user in Settings). Default cabins: economy + premium_economy.
- **Catalog**: ~80 destinations in `destinations.ts`, seeded on first migration. Tier 1 (~20) favorites (CUN, HNL, LHR, CDG, NRT, FCO, BCN, MEX...), Tier 2 (~40) broad coverage (NAP, IST, ATH, LIS, KEF, BKK...), Tier 3 (~20) long-tail (HYD, FAI, AKL, CPT...). Editable/toggleable in DB.
- **Budget**: each call is a headless page load against Google, so the budget is a politeness cap: `daily_call_budget` setting, default **100** (4 batches of 25, each batch ~3 min with jittered gaps). Full ~560-combo universe cycles in ~6 days via the tier rotation; raise the budget if that proves too slow.
- **Rotation** (`planner.ts`): priority = hours-since-last-snapshot × tier weight (T1×3, T2×1.5, T3×1) × near-month boost (+1..+3 higher). Each batch takes the top-N stalest within remaining budget — under the default budget everything gets scanned daily; the rotation only matters if the budget is lowered.
- **Schedule** (`scheduler.ts`): node-cron, 4 batches/day (06:10, 11:10, 17:10, 22:10 America/Denver) of budget/4 each; startup catch-up if >12h idle; `scan_enabled` kill switch. `quota.ts` counts `api_calls` and refuses batches that would exceed the daily cap.

## 6. Deal detection, scoring, alerting

**Baseline** per (origin, destination, travel_month) — computed over **daily-cheapest** prices (min per capture day), never raw snapshots: each scan stores several date-pair quotes and the "current price" is the cheapest of the latest scan, so a median over all quotes would sit structurally above any day's cheapest and make every route look ~10% discounted forever (bug found via the seed simulator):
1. Median of the month's daily minima over last 60 days, if ≥10 capture days.
2. Fallback: median of the whole route's daily minima over 90 days, if ≥14 capture days.
3. Fallback: **Google's own price history**. Every result page carries a price-insights
   block ("Prices are currently low/typical/high") and, behind one in-page click, a
   ~60-day price-history graph for the searched trip (bar aria-labels like
   "61 days ago - $494"). While a route-month lacks its own baseline the scanner pays
   that click, stores the series in `price_insights`, and its median becomes a
   bootstrap baseline — deals and alerts can fire on **day one**, marked
   `baseline_source='google'` and shown as "est." in the UI. The series (daily lowest
   prices, same basis as our daily minima) also supplies the percentile history for
   scoring. Our own baselines take over automatically as they mature, and the click
   cost decays to ~zero.
4. Otherwise **cold start**: collect only — no deal, no alert. UI shows "building price history" banner with coverage %.

**Score** (pure function):
```
score += {low: +8, typical: 0, high: -8}[google price-insights verdict]   // corroboration nudge, clamped 0–100
percentile  = fraction of the route's 90-day daily minima strictly more expensive than current price
discountPct = (baseline - current) / baseline
score       = round(100 · (0.6·percentile + 0.4·clamp(discountPct / 0.40, 0, 1)))
```
A price 40% below baseline and cheaper than all history ≈ 100; a median price ≈ 50. The UI's crossed-out price is the baseline.

**Deal lifecycle** (`detect.ts`): after each snapshot, recompute; `discountPct > 5%` → upsert deal (UNIQUE route+month); mark `expired` when price returns within 5% of baseline or the month passes.

**Alert rule** (`notify.ts`) — send when ALL hold:
- score ≥ `alert_threshold` (default 85)
- discountPct ≥ 20% (floor against percentile flukes on flat routes)
- baseline exists (cold-start gate)
- cooldown: no alert for this route+month in 7 days, **unless** price is ≥10% below the last alerted price (re-alert on deepening deals)

**Email** (Resend): subject like `✈ ABQ → Naples $758 (33% off, score 93) — Aug 2026`; HTML body mirrors the deal card, includes the exact dates and a **Google Flights deep link** (`https://www.google.com/travel/flights?tfs=…` — a deterministic base64 protobuf of route/dates/cabin; the natural-language `?q=` form was dropped after it silently failed to apply the premium-economy cabin filter) — this is the "where to purchase" pointer. Footer notes prices are indicative. Recorded in `alerts`.

## 7. HTTP API

| Route | Purpose |
|---|---|
| `GET /api/deals` | Feed: active deals, score desc (city, country, month, score, baseline vs current) |
| `GET /api/deals/:id` | Deal + recent date-pair options for the route, cheapest first |
| `GET/PUT /api/settings` | home_airport, alert_email, alert_threshold, daily_call_budget, scan_enabled (zod-validated) |
| `GET /api/status` | last scan, calls used today/month, baseline coverage %, provider name |
| `POST /api/scan` | Manual batch trigger (respects quota guard) |
| `POST /api/test-email` | Sends a sample alert to verify Resend config |

Non-`/api` paths serve `web/dist` with SPA fallback. Single port 3789. No auth (LAN-only); nginx basic-auth can be added later if ever exposed.

## 8. Frontend

Three screens, styled after `ui-samples/`:

- **DealsFeed** (default tab): pale-blue header with route pill ("Albuquerque International… ⇄ Anywhere"), white rounded cards — bold city, "Country • Mon, YYYY", green `NN% deal score` pill, crossed-out grey baseline + bold current price + chevron. StatusBanner during cold start / quota exhaustion.
- **DealDetail**: back arrow, `Albuquerque ⇄ Naples` heading, Best/Cheapest-badged top option in a green-tinted card, then date-option rows ("Aug 18 – Aug 26 · Round trip · 8 nights"); each row links out to Google Flights. (Segment-level itinerary view from screenshot 4 is out of scope for v1.)
- **Settings**: grey rounded field rows — home airport (IATA), alert email, threshold slider (50–100), scan toggle — plus status (quota, last scan) and a "Send test email" button.
- Two-tab TabBar (Deals / Settings). PWA manifest + icons for add-to-home-screen; no service worker in v1. Dev: Vite on 5173 proxying `/api` → 3789.

## 9. Deployment

- **systemd** `deploy/rate-pirate.service`: `WorkingDirectory=/opt/rate-pirate`, `EnvironmentFile=.env`, runs the server via tsx, `Restart=always`. Host needs Node 22 LTS (NodeSource) and `apt install chromium` for the google-flights provider.
- **nginx** server block on a free port (e.g. 8081) → `proxy_pass http://127.0.0.1:3789`.
- **deploy.sh**: build web+server locally → rsync `server/dist`, `web/dist`, package manifests, migrations to `your-server.local:/opt/rate-pirate` → `npm ci --omit=dev` on the server (native better-sqlite3 builds on matching arch) → `systemctl restart rate-pirate`.
- DB at `/opt/rate-pirate/data/rate-pirate.db`; nightly `sqlite3 .backup` cron on the host.
- Provider is `google-flights` in prod (needs Chromium on the host); `mock` seeds synthetic demo data. **Demo/live separation:** booting with `PROVIDER=mock` auto-seeds 14 days of synthetic history for *all four cabins* (so toggling cabins shows data instantly) if any cabin lacks a baseline; booting with `PROVIDER=google-flights` purges every mock row so only real scraped data remains. The two never mix (all snapshot/deal/status queries are scoped by `source`).

## 10. Implementation phases & verification

| Phase | Scope | Verification |
|---|---|---|
| **0 — Scaffold** (½d) | git init; workspaces, tsconfig, ESLint/Prettier, vitest; Hono `/api/health`; Vite shell + TabBar; shared types; `.env.example`; update CLAUDE.md with real commands | `npm run dev` (UI + proxied health); `npm test`; `npm run build && npm start` serves SPA on 3789 |
| **1 — Storage + providers** (1d) | schema/migrations, settings precedence, destination seed, repo; provider interface, mock, Google Flights scraper | unit tests on temp DB; mock determinism; live smoke via `scripts/gf-smoke.ts` (a few real page loads) |
| **2 — Scanner** (1d) | planner, quota guard, batch exec, cron, pruning, `POST /api/scan` | planner/quota unit tests; 30-virtual-day simulator asserting per-tier cadence and calls ≤ budget; zero live calls |
| **3 — Deals + email** (1d) | baseline/score/detect/notify; Resend client + template; `seed-history.ts` | pure-fn edge cases; fake-clock cooldown tests; simulator: 40% drop on day 45 → exactly one alert, re-alert only on deepening; one real test email |
| **4 — API** (½d) | all routes, zod, error handling | `app.request()` tests against seeded temp DB |
| **5 — UI** (1–2d) | three pages + components; loading/empty/cold-start states; PWA manifest | seed + dev server, visual check vs `ui-samples/` at iPhone width; settings persistence; prod build via server binary |
| **6 — Deploy** (½–1d) | systemd, nginx, deploy.sh, backups, prod keys | `curl http://your-server.local:8081/api/status` from Mac; UI on phone + add to home screen; watch one cron batch in journalctl; confirm real alert email |

~5–7 focused days total.

## 11. Risks & open items

1. **Google Flights scraping fragility** — Google can change page internals or challenge automated traffic. Mitigations: aria-labels are the most change-resistant surface; volume is tiny (~100 loads/day, jittered); transient-error retry built in; failures surface in `api_calls` and `/api/status`. If it ever breaks hard, the `FlightPriceProvider` seam keeps the blast radius to one file (this project already outlived two providers: Amadeus decommissioned its self-service portal mid-build, and Travelpayouts turned out to have ~2% ABQ coverage and was removed).
2. **One date pair per route-month** — the representative-dates heuristic (2nd Saturday, 7 nights) samples one itinerary shape; deals tied to other patterns (mid-week, long stays) go unseen. Acceptable v1 trade-off; the date-grid view (~49 pairs per page load) is the natural upgrade if wanted.
3. **Premium-cabin scrape query — verified for business/first, phrasing matters.** The provider appends `in <cabin>` (e.g. `… in business class`) to the query. This was verified live: `in business class` on JFK-LHR returned $3,777 and `in first class` $6,434–7,798, vs `$610–1,006` economy — correct, correctly-parsed premium fares. **The leading "in" is load-bearing** — a bare `business class` returns no results; Google's query parser only applies the cabin filter with the "in" form. Premium economy uses the identical code path but couldn't get a clean live read (the dev machine was progressively throttled by Google — the *same* query flips between real results, blank pages, and the "Oops" error regardless of IP/VPN). First production scan should still spot-check that premium-economy snapshots return plausibly-higher-than-economy prices. If Google ever stops honoring the NL phrase, the fallback is the `tfs` protobuf cabin field — a one-file change in `google-flights.ts`.
3. **Resend sender identity** — without a verified domain, Resend sends only from `onboarding@resend.dev` to the account owner's address. Fine for self-alerts; verify proton.me deliverability in Phase 3, else verify a domain.
4. **Indicative prices** — cached quotes can differ from live checkout prices; the Google Flights link is the source of truth for purchase. Noted in the email footer.
5. **Cold start** — first ~2 weeks are collect-only per route; StatusBanner and `/api/status` coverage % keep this legible.
6. **Travel-month horizon** (6 months default) — one constant in `planner.ts`; widening it grows the scan universe (already ×cabins) and the snapshot table.
