# Rate Pirate 🏴‍☠️

Personal flight-deal monitor: scans round-trip prices from ABQ to ~90 destinations
worldwide by scraping Google Flights, and emails an alert when a price drops far
below that route's recent norm. Deals link out to Google Flights for booking — the
app never books anything. Design details live in [DESIGN.md](DESIGN.md); developer
notes in [CLAUDE.md](CLAUDE.md).

- **App (production):** http://your-server.local:8081 — add to your phone's home screen
- **Runs on:** `your-server.local` (Debian 12), app dir `/opt/rate-pirate`
- **Alerts:** emailed when a deal scores ≥ threshold (default 85) **and** beats the
  minimum discount (default 20% below the route's baseline); cooldown per route-month
  (default 7 days) unless the price drops another 10%. Thresholds are editable in
  Settings (→ Advanced). Sent via SMTP (Proton Bridge) or Resend — see "Email" below.

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

**Settings → Activity log** shows the last 50 events (batch summaries, alerts
sent, and any scan/alert errors with expandable stack traces) — check there
before reaching for journalctl. The feed shows a red banner when a meaningful
share of the day's scans fail. Raw JSON: `curl -s localhost:3789/api/events`.

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

### Adjust the daily call budget

The budget caps how many Google Flights page loads the scanner makes per day
(resets at local midnight). Set it in the app under **Settings → Advanced**, or
via the API; either way it takes effect at the next batch, no restart needed:

```bash
curl -s -X PUT -H 'content-type: application/json' \
  -d '{"dailyCallBudget":300}' localhost:3789/api/settings
```

Sizing: the scan universe is `destinations × 6 months × monitored cabins` calls
(157 × 6 × 2 cabins ≈ 1,900). A route-month only gets a **month baseline** with
captures on 10 distinct days inside a 60-day window, so each unit needs a scan
at least every ~6 days: `budget ≥ universe / 5` is a good floor (≈ 380 for two
cabins, ≈ 190 for one). Below that, routes fall back to the coarser all-months
route baseline and seasonality is blurred. Each call is a throttled headless-
Chrome page load (4–7 s apart); ~300/day ≈ 8 minutes of scraping per batch.
Stay well under ~500/day to keep Google friendly — if scans start failing
consistently, lower it.

### Send a test email

```bash
curl -s -X POST localhost:3789/api/test-email
```

Sends the sample alert to every address in the alert-email setting. `{ sent: true }`
means the send succeeded; `{ sent: false, error: ... }` is the sender's error verbatim.

### Email

The app picks a sender by what's configured, in this order: **SMTP** (if `SMTP_HOST`
is set) → **Resend** (if `RESEND_API_KEY` is set) → console log (dev). The alert-email
setting accepts **multiple recipients**, comma-separated; all of them get every alert.

#### Email via Proton Bridge (current setup)

Proton has no plain SMTP for `@proton.me`, so we run **Proton Bridge** on the server —
a local daemon that exposes an authenticated SMTP endpoint the app talks to. Requires a
paid Proton plan. One-time setup on `your-server.local`:

1. **Install Bridge (headless).** Download the Debian package from
   <https://proton.me/mail/bridge> (or `proton-mail-bridge` if packaged) and install it.
   Bridge needs a keychain to store its vault; on a headless box use `pass` (backed by
   a passphrase-less GPG key so Bridge can decrypt non-interactively). Run these as the
   **same user that will run Bridge** — the keychain is per-user:
   ```bash
   sudo apt install -y pass gnupg
   gpg --batch --passphrase '' --quick-generate-key "rate-pirate-bridge" default default never
   pass init "$(gpg --list-secret-keys --with-colons rate-pirate-bridge | awk -F: '/^fpr:/{print $10; exit}')"
   ```
2. **Log in.** Run the Bridge CLI and sign in with your Proton account (+ 2FA):
   ```bash
   protonmail-bridge --cli
   >>> login          # follow prompts; then:
   >>> info           # shows the SMTP host/port, username, and Bridge PASSWORD
   ```
   The Bridge **password** shown here is app-specific — not your Proton login. Copy it.
   (The first login also kicks off a mailbox sync, ETA up to ~1h — you can ignore it;
   we only send mail, never read, so sending works before it finishes.)
3. **Keep it running.** Exit the interactive CLI, then run Bridge as a background
   service so it survives reboots — install `deploy/protonmail-bridge.service`:
   ```bash
   which protonmail-bridge     # confirm path; adjust the unit's ExecStart if needed
   sudo cp deploy/protonmail-bridge.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now protonmail-bridge
   journalctl -u protonmail-bridge -f      # watch for keychain errors on first start
   ss -tlnp | grep 1025                     # confirm Bridge SMTP is listening
   ```
4. **Point the app at it** — in `/opt/rate-pirate/.env`:
   ```ini
   ALERT_EMAIL_FROM=you@proton.me
   SMTP_HOST=127.0.0.1
   SMTP_PORT=1025
   SMTP_USER=you@proton.me
   SMTP_PASS=<bridge password from step 2>
   SMTP_SECURE=false
   SMTP_ALLOW_INVALID_CERT=true      # Bridge uses a localhost self-signed cert
   ```
   Then `sudo systemctl restart rate-pirate` and `curl -s -X POST localhost:3789/api/test-email`.

Because mail goes out through your real Proton account, alerts can be delivered to **any**
address (yourself, family, teammates) — no domain or per-recipient verification needed.

Note: Bridge must stay running for alerts to send. If it's down, sends fail and are retried
on the next scan (the deal stays flagged); no alerts are lost silently — failures log to
`journalctl -u rate-pirate`.

#### Resend (fallback)

Leave `SMTP_HOST` empty and set `RESEND_API_KEY` to use Resend instead. Without a verified
domain, Resend only delivers to the account owner's own address — which is why we moved to
Bridge for multi-recipient alerts.

### Configuration

Two layers:

- **`/opt/rate-pirate/.env`** — secrets and machine config (SMTP /
  Resend, provider choice, port, DB path). Edit, then `sudo systemctl restart rate-pirate`.
- **Settings UI / API** — home airport, alert email (comma-separated for multiple),
  alert threshold, cabins, scan on/off, and which destinations to scan
  (Settings → Destinations — deactivating expires its deals but keeps history);
  under **Advanced**: daily call budget (see "Adjust the daily call budget"
  above), alert minimum discount (default 20%), re-alert cooldown (default
  7 days), and scan horizon (default 6 months). All in the DB; no restart needed.

### Demo mode (mock data)

To show the app with a fully populated feed (e.g. before enough live history has
accumulated), set `PROVIDER=mock` in `.env` and restart the service. On boot the
app auto-seeds 14 days of synthetic price history and deals **for all four cabins**
— the UI is populated immediately, and toggling cabins in Settings shows demo data
for any cabin instantly. Live data keeps its own lane: it is neither shown nor
touched while in demo mode.

To go (back) live, set `PROVIDER=google-flights` and restart — all mock data is
purged automatically on boot and only real history is shown. Mock and live data
never mix, so flipping between them is always safe. One caveat: scans only run
for the active provider, so days spent in demo mode leave a gap in live price
history.

### Database

SQLite at `/opt/rate-pirate/data/rate-pirate.db`.

```bash
sqlite3 /opt/rate-pirate/data/rate-pirate.db \
  "SELECT COUNT(*) FROM price_snapshots;"                      # data volume
sqlite3 /opt/rate-pirate/data/rate-pirate.db \
  "SELECT destination, travel_month, score, best_price_cents/100
   FROM deals WHERE status='active' ORDER BY score DESC;"      # current deals
```

### Backups

Two layers — the on-host copy protects against app/DB corruption, the off-host
copy against the disk/pool dying (which would otherwise take the live DB *and*
its backups together):

1. **On your-server.local** — nightly `.backup`, 7 rotating daily copies. One-time
   setup, as ryan (no sudo):

   ```bash
   ssh -t your-server.local '(crontab -l 2>/dev/null; echo "15 2 * * * sqlite3 /opt/rate-pirate/data/rate-pirate.db \".backup /opt/rate-pirate/data/backup-\$(date +\%w).db\"") | crontab -'
   ```

2. **Off-host** — pull the rotation to another machine with
   `deploy/pull-backups.sh` (run from the Mac; cron it or run it occasionally).

Losing the DB is not fatal — deals regenerate — but baselines need ~2 weeks of
scanning to become trustworthy again, so alert quality degrades until then.

Old data prunes itself: price snapshots after 180 days, API-call logs after 60,
activity-log events after 30.

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
| Scans failing | **Settings → Activity log** in the app shows each failure with its error (also `journalctl -u rate-pirate --since today \| grep 'scan failed'`). Occasional `TransientPageError` is normal (Google hiccup — retried next batch). Many consecutive failures usually mean Google changed its page or is challenging the server's IP; try `chromium --version` and reduce the daily call budget (see "Adjust the daily call budget"). |
| No deals after 2+ weeks | Settings → Status: is `baselineCoverage` growing? Is `callsToday` > 0? If scanning is on and coverage is high, there simply may be no qualifying deals — lower the alert threshold to see more. |
| No alert emails | Send a test email (above) and read the returned error. On Proton Bridge, check Bridge is running (`ss -tlnp \| grep 1025`). Remember alerts also require the minimum discount (default 20%, Settings → Advanced), not just a high score. |
| Service won't start | `journalctl -u rate-pirate -n 50`. Common causes: missing `/opt/rate-pirate/.env`, or `node`/`chromium` missing after an OS reinstall (`apt install nodejs chromium`). |
| Chromium won't launch (sandbox errors in the log) | Set `CHROME_NO_SANDBOX=true` in `.env` and restart — needed only on containers/unusual kernels; sandboxed is the safer default. |

## Local development (macOS)

```bash
npm run dev        # server :3789 + Vite UI :5173 (mock provider unless .env says otherwise)
npm test           # unit + simulator tests (no network)
npm -w server exec tsx scripts/seed-history.ts   # fake 2 weeks of history for the UI
npm -w server exec tsx scripts/gf-smoke.ts       # live Google Flights smoke (~4 page loads)
```

See [CLAUDE.md](CLAUDE.md) for the full command list and architecture map.
