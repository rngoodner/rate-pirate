# Rate Pirate 🏴‍☠️

Personal flight-deal monitor: scans round-trip prices from ABQ to ~90 destinations
worldwide by scraping Google Flights, and emails an alert when a price drops far
below that route's recent norm. Deals link out to Google Flights for booking — the
app never books anything. Design details live in [DESIGN.md](DESIGN.md); developer
notes in [CLAUDE.md](CLAUDE.md).

- **App (production):** http://your-server.local:8081 — add to your phone's home screen
- **Runs on:** `your-server.local` (Debian 12), app dir `/opt/rate-pirate`
- **Alerts:** sent via Resend when a deal scores ≥ threshold (default 85) **and**
  is ≥20% below the route's baseline; 7-day cooldown per route-month unless the
  price drops another 10%

## Administering the service (on your-server.local)

All commands below run on the server (`ssh your-server.local`).

### Start / stop / restart

```bash
sudo systemctl start rate-pirate
sudo systemctl stop rate-pirate
sudo systemctl restart rate-pirate
sudo systemctl disable --now rate-pirate   # stop and don't start at boot
sudo systemctl enable --now rate-pirate    # start now and at every boot
```

### Health & status

```bash
systemctl status rate-pirate               # process state, recent log lines
journalctl -u rate-pirate -f               # follow live logs
journalctl -u rate-pirate --since today    # today's logs
curl -s localhost:3789/api/status          # app status: last scan, calls used,
                                           # baseline coverage %, active deals
```

The same status JSON is shown in the app's **Settings** tab. `baselineCoverage`
climbs toward 1.0 over the first ~10 days; deals and alerts only start once
routes have baselines (by design — no false alerts during cold start).

### Pause / resume scanning (without stopping the app)

Use the **Scanning** toggle in the app's Settings tab, or:

```bash
curl -s -X PUT -H 'content-type: application/json' \
  -d '{"scanEnabled":false}' localhost:3789/api/settings   # pause
curl -s -X PUT -H 'content-type: application/json' \
  -d '{"scanEnabled":true}'  localhost:3789/api/settings   # resume
```

### Trigger a scan batch manually

```bash
curl -s -X POST localhost:3789/api/scan
```

Respects the daily budget; returns `{"planned":…,"scanned":…,"snapshots":…,"failures":…}`.
Scheduled batches run at 06:10, 11:10, 17:10, 22:10 America/Denver.

### Send a test email

```bash
curl -s -X POST localhost:3789/api/test-email
```

Note: until a domain is verified at resend.com/domains, Resend only delivers to
the account owner's address (ryangoodner@pm.me).

### Configuration

Two layers:

- **`/opt/rate-pirate/.env`** — secrets and machine config (Resend
  key, provider choice, port, DB path). Edit, then `sudo systemctl restart rate-pirate`.
- **Settings UI / API** — home airport, alert email, alert threshold, daily call
  budget, scan on/off. Stored in the database; no restart needed.

### Database

SQLite at `/opt/rate-pirate/data/rate-pirate.db`.

```bash
sqlite3 /opt/rate-pirate/data/rate-pirate.db \
  "SELECT COUNT(*) FROM price_snapshots;"                      # data volume
sqlite3 /opt/rate-pirate/data/rate-pirate.db \
  "SELECT destination, travel_month, score, best_price_cents/100
   FROM deals WHERE status='active' ORDER BY score DESC;"      # current deals
```

Recommended nightly backup (add via `crontab -e` on the server; keeps 7 rotating
daily copies):

```
15 2 * * * sqlite3 /opt/rate-pirate/data/rate-pirate.db ".backup /opt/rate-pirate/data/backup-$(date +\%w).db"
```

Old data prunes itself: price snapshots after 180 days, API-call logs after 60.

### Deploying an update

From the dev machine (this repo, macOS):

```bash
./deploy/deploy.sh
```

Builds the frontend, rsyncs the app to the server, reinstalls production deps,
restarts the service, and smoke-checks `/api/health`.

### nginx

The site config lives at `/etc/nginx/sites-available/rate-pirate` (port **8081** →
app on 3789; 80/8080/32400 belong to other apps on this host — never reuse them).

```bash
sudo nginx -t && sudo systemctl reload nginx   # after editing the site config
```

## Troubleshooting

| Symptom | Check |
|---|---|
| App unreachable at :8081 | `systemctl status rate-pirate`, then `curl localhost:3789/api/health` on the server (isolates app vs nginx), then `sudo nginx -t` |
| Scans failing | `journalctl -u rate-pirate --since today \| grep 'scan failed'`. Occasional `TransientPageError` is normal (Google hiccup — retried next batch). Many consecutive failures usually mean Google changed its page or is challenging the server's IP; try `chromium --version` and reduce `dailyCallBudget` in Settings. |
| No deals after 2+ weeks | Settings → Status: is `baselineCoverage` growing? Is `callsToday` > 0? If scanning is on and coverage is high, there simply may be no qualifying deals — lower the alert threshold to see more. |
| No alert emails | Send a test email (above). Remember the Resend test-mode restriction, and that alerts also require a ≥20% discount, not just a high score. |
| Service won't start | `journalctl -u rate-pirate -n 50`. Common causes: missing `/opt/rate-pirate/.env`, or `node`/`chromium` missing after an OS reinstall (`apt install nodejs chromium`). |

## Local development (macOS)

```bash
npm run dev        # server :3789 + Vite UI :5173 (mock provider unless .env says otherwise)
npm test           # unit + simulator tests (no network)
npm -w server exec tsx scripts/seed-history.ts   # fake 2 weeks of history for the UI
npm -w server exec tsx scripts/gf-smoke.ts       # live Google Flights smoke (~4 page loads)
```

See [CLAUDE.md](CLAUDE.md) for the full command list and architecture map.
