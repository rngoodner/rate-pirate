# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Rate Pirate is a single-user, mobile-first TypeScript web app that monitors round-trip flight prices from a home airport (default ABQ) to ~80 worldwide destinations and emails the user (via Resend) when a price drops far below the historical norm. It finds deals and links out to Google Flights for purchase — **no booking**. The full design (architecture, schema, scoring formulas, phases) is in `DESIGN.md`; UI reference screenshots are in `ui-samples/`.

Flight data comes from the **Travelpayouts/Aviasales Data API** (free token). Do not suggest Amadeus — its self-service portal was decommissioned July 2026.

## Commands

Node 22 is required (installed via Homebrew: `/opt/homebrew/opt/node@22/bin` may need to be on PATH).

- `npm run dev` — server (tsx watch, port 3789) + Vite dev server (port 5173, proxies `/api`) concurrently
- `npm test` — server unit tests (vitest); single test: `npm -w server run test -- src/test/health.test.ts` or `-t 'name'`
- `npm run typecheck` — tsc --noEmit in server and web
- `npm run build` — builds the web SPA to `web/dist`
- `npm start` — production mode: server on 3789 also serving `web/dist` (build first)
- `npm run lint` / `npm run format` — eslint / prettier

Copy `.env.example` to `.env` for local config. Without `TRAVELPAYOUTS_TOKEN`, the app defaults to the mock provider.

## Architecture

npm workspaces: `shared/` (API wire types, source-only package consumed as TS), `server/`, `web/`. One Node process in production: Hono serves the JSON API and the built SPA on port 3789. SQLite via better-sqlite3 (DB file in `data/`, gitignored). Server runs under `tsx` (no compile step); web builds with Vite.

Server module boundaries (see DESIGN.md §2):
- `providers/` — `FlightPriceProvider` seam (`monthQuotes` per route+month); `travelpayouts.ts` real client, `mock.ts` fixtures + seeded synthetic prices. All dev/testing uses the mock.
- `scanner/` — the only consumer of `providers/`; cron-driven, budget-capped rotation over route-months.
- `deals/` + `alerts/` — pure logic over repo data; never import `providers/`.
- `db/repo.ts` — all SQL; `api/` reads only through it.

## Deployment target

- Production: Debian 12 home server, `ssh your-server.local`, app at `/opt/rate-pirate`, DB at `data/rate-pirate.db` there.
- nginx exposes the app on port **8081** → proxies to the app on **3789**. Ports 80, 8080, 32400 are taken by other apps on that host — never bind them.
- Deploy via `deploy/deploy.sh` (build → rsync → npm ci → systemctl restart rate-pirate). Development/testing happens locally on macOS.
