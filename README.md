# Rate Pirate 🏴‍☠️

Your own flight-deal watchdog. It checks round-trip prices from your home airport
to **Anywhere** on Google Flights a few times a day, and emails you when a fare
drops far below what that trip normally costs. Every deal links straight to Google
Flights to book — **Rate Pirate never books or pays for anything itself.**

**Why it exists.** Great flight deals are rare, short-lived, and easy to miss — and
the flexible traveler who'll go *wherever's cheap* is exactly who benefits most from
catching them. Rate Pirate watches continuously so you don't have to: it learns what
each trip normally costs, and pings you only when something is genuinely, unusually
cheap. No feeds to scroll, no daily fare-checking — just an email when it's worth
your attention.

**Also a bit of an experiment.** This project was built to explore
[Claude Code](https://claude.ai/code) and see how far AI can go on a real,
end-to-end application — not a toy demo, but something with a live scraper, a
database, a scheduler, email delivery, and a mobile UI, kept working and useful over
time. It's a genuine tool *and* a test of what AI-assisted development can produce.

It's built to self-host: one small Linux machine runs it 24/7, and you reach it
from your phone like a normal app. This guide gets you from nothing to a home-screen
icon in five steps.

---

## What you'll need

- **A Linux machine that stays on** — a spare PC, a home server, or a cheap VPS.
  Debian or Ubuntu is easiest to follow.
- **A free [Tailscale](https://tailscale.com) account** — a private network so your
  phone can reach the app from anywhere, with no port-forwarding or router changes.
- **A way to send email** — a free [Resend](https://resend.com) account is the
  quickest; any SMTP server also works. (Details in [Email alerts](#email-alerts).)

---

## 1. Install

On the Linux machine:

```bash
# Node 22 LTS + Chromium (the app scrapes Google Flights with headless Chrome) + git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs chromium git
# On Ubuntu the package may be "chromium-browser" instead of "chromium".

# Get the code and build it
sudo mkdir -p /opt/rate-pirate && sudo chown "$USER" /opt/rate-pirate
git clone https://github.com/rngoodner/rate-pirate.git /opt/rate-pirate
cd /opt/rate-pirate
npm ci
npm run build
```

## 2. Configure

Copy the example config and open it:

```bash
cp .env.example .env
nano .env
```

For a first run you only need a provider and email. A minimal `.env`:

```ini
PROVIDER=google-flights

# Who alerts come from / go to (also editable later in the app's Settings).
ALERT_EMAIL_FROM=onboarding@resend.dev
ALERT_EMAIL_TO=you@example.com

# Easiest email option — a Resend API key (see "Email alerts" below).
RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
```

Leave the rest at their defaults. Your **home airport**, trip lengths, cabins, and
alert thresholds are all set in the app later — no need to touch them here.

## 3. Run it

The app runs as a systemd service so it starts on boot and restarts if it crashes.
Edit the provided unit to match your machine:

```bash
sudo cp deploy/rate-pirate.service /etc/systemd/system/
sudoedit /etc/systemd/system/rate-pirate.service
```

Set these three lines:

```ini
User=yourusername
WorkingDirectory=/opt/rate-pirate
EnvironmentFile=/opt/rate-pirate/.env
Environment=TZ=America/Denver     # your timezone, so daily budgets reset at your midnight
```

Then start it and confirm it's healthy:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rate-pirate
curl -s localhost:3789/api/health        # → {"ok":true}
```

The app is now running on port **3789**.

## 4. Reach it from your phone (Tailscale)

Tailscale puts the server and your phone on the same private network, so the app is
reachable from anywhere without exposing it to the public internet.

On the **server**:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 3789      # serve the app over HTTPS on your tailnet
tailscale status                    # note this machine's name, e.g. "homeserver"
```

On your **phone**: install the Tailscale app (App Store / Play Store), sign in with
the **same account**, and turn it on. In the Tailscale admin console, make sure
**MagicDNS** is enabled so the machine name resolves.

Now open the app in your phone's browser:

```
https://<machine-name>.<your-tailnet>.ts.net
```

(`tailscale serve` prints the exact URL. Prefer plain HTTP? It's also at
`http://<machine-name>:3789` on the tailnet.)

## 5. Pin it as an app

Open the URL above in your phone's browser, then add it to your home screen — it
launches full-screen with its own icon, just like a native app:

- **iPhone / iPad (Safari):** tap **Share** → **Add to Home Screen**.
- **Android (Chrome):** tap **⋮** → **Add to Home screen** (or **Install app**).

That's it. Open **Settings** in the app, set your home airport and preferences, and
the feed fills in over the first day of scanning.

---

## Using it

Everything is in the app's **Settings** tab:

- **Home airport, trip types** (weekend / 1 week / 2 weeks), **cabins**, and
  **number of adults** — what to search.
- **Airlines** — hide carriers you'll never fly; the rest show in the feed and can
  trigger emails.
- **Alert recipients** — one or more addresses (comma-separated); send a test email
  to confirm delivery.
- **Email alerts** — the minimum score (default 85) and an optional maximum price.
- **Scanning** — an on/off switch to pause checks and alerts.

**When you get an email:** a deal must score at or above your threshold **and** beat
the minimum discount (default 20% below the trip's typical price). The same deal
won't re-alert for a cooldown period (default 7 days) unless its price drops another
10%. Finer knobs live under **Settings → Advanced**.

Scans run automatically four times a day. The **Activity log** (Settings) shows
recent batches, alerts sent, and any errors — the first place to look if something
seems off.

## Email alerts

The app sends through whatever you configure, preferring **SMTP** if set, otherwise
**Resend**, otherwise just logging to the console (useful while testing).

**Resend (easiest).** Create a free account at [resend.com](https://resend.com) and
make an API key. Put it in `.env` as `RESEND_API_KEY`, and restart. Without your own
verified domain, Resend only delivers to *your own* account email and the From
address must be `onboarding@resend.dev` — fine for a personal setup. To email other
people (family, etc.), verify a domain in Resend or use Proton Bridge (Advanced).

**SMTP.** If you already have an SMTP server, set `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS` in `.env` and restart. See `.env.example` for every field.

After changing email settings, restart and send a test:

```bash
sudo systemctl restart rate-pirate
curl -s -X POST localhost:3789/api/test-email
```

---

## Advanced

Everything below is optional — skip it unless you need it.

### Manual control from the command line

```bash
# Pause / resume scanning (same as the Settings toggle)
curl -s -X PUT -H 'content-type: application/json' -d '{"scanEnabled":false}' localhost:3789/api/settings
curl -s -X PUT -H 'content-type: application/json' -d '{"scanEnabled":true}'  localhost:3789/api/settings

# Run a scan batch now (respects the daily budget)
curl -s -X POST localhost:3789/api/scan

# Change the daily page-load budget (takes effect next batch, no restart)
curl -s -X PUT -H 'content-type: application/json' -d '{"dailyCallBudget":300}' localhost:3789/api/settings

# Live status and event log
curl -s localhost:3789/api/status
curl -s localhost:3789/api/events

# Service control and logs
sudo systemctl restart rate-pirate
journalctl -u rate-pirate -f
```

### Daily call budget

The budget caps how many Google Flights page loads the scanner makes per day
(resets at your local midnight). Each batch does one **Explore** load per monitored
`trip type × cabin`, then prices destinations cheapest-first, up to `budget ÷ 4` per
batch. Explore surfaces dozens of destinations, so a full pass spans several batches
and the feed fills in over a day. **200–500** covers a few combos comfortably. Each
load is a throttled headless-Chrome page (~2–3.5 s apart) — stay under ~500/day to
keep Google friendly, and lower it if scans start failing consistently.

### Email via Proton Bridge (send from @proton.me to anyone)

Proton has no plain SMTP, so run **Proton Bridge** on the server — a local daemon
exposing an authenticated SMTP endpoint. Requires a paid Proton plan, but then
alerts can go to **any** address with no domain verification.

1. **Install Bridge (headless).** Download the Debian package from
   <https://proton.me/mail/bridge>. Bridge needs a keychain; on a headless box use
   `pass` with a passphrase-less GPG key so it can decrypt non-interactively. Run as
   the **same user** that will run Bridge:
   ```bash
   sudo apt install -y pass gnupg
   gpg --batch --passphrase '' --quick-generate-key "rate-pirate-bridge" default default never
   pass init "$(gpg --list-secret-keys --with-colons rate-pirate-bridge | awk -F: '/^fpr:/{print $10; exit}')"
   ```
2. **Log in and get the SMTP password:**
   ```bash
   protonmail-bridge --cli
   >>> login      # follow prompts (+ 2FA)
   >>> info       # shows SMTP host/port, username, and the Bridge PASSWORD (app-specific, not your login)
   ```
3. **Keep it running** as a service:
   ```bash
   which protonmail-bridge     # confirm path; adjust the unit's ExecStart if needed
   sudo cp deploy/protonmail-bridge.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now protonmail-bridge
   ss -tlnp | grep 1025        # confirm Bridge SMTP is listening
   ```
4. **Point the app at it** in `.env`, then restart and send a test email:
   ```ini
   ALERT_EMAIL_FROM=you@proton.me
   SMTP_HOST=127.0.0.1
   SMTP_PORT=1025
   SMTP_USER=you@proton.me
   SMTP_PASS=<bridge password from step 2>
   SMTP_SECURE=false
   SMTP_ALLOW_INVALID_CERT=true    # Bridge uses a localhost self-signed cert
   ```

Bridge must stay running for alerts to send. If it's down, sends fail and retry on
the next scan — nothing is lost silently; failures show in the Activity log.

### Serve on your LAN with nginx (instead of, or alongside, Tailscale)

To reach the app by a hostname on your home network, put nginx in front of it.
`deploy/nginx.conf` is a starting point (listens on 8081 → app on 3789). Copy it to
`/etc/nginx/sites-available/rate-pirate`, symlink it into `sites-enabled`, then
`sudo nginx -t && sudo systemctl reload nginx`.

### Backups

The database is SQLite at `<install-dir>/data/rate-pirate.db`. Losing it isn't
fatal — deals regenerate within a day or two, since baselines come from Google's own
price history. For peace of mind, a nightly rotating backup (as your app user):

```bash
(crontab -l 2>/dev/null; echo "15 2 * * * sqlite3 /opt/rate-pirate/data/rate-pirate.db \".backup /opt/rate-pirate/data/backup-\$(date +\%w).db\"") | crontab -
```

`deploy/pull-backups.sh` copies the rotation to another machine (against disk death).
Old data prunes itself: snapshots after 180 days, call logs after 60, events after 30.

### Inspect the database

```bash
sqlite3 /opt/rate-pirate/data/rate-pirate.db \
  "SELECT destination, trip_type, cabin, score, best_price_cents/100
   FROM deals WHERE status='active' ORDER BY score DESC;"
```

### Demo mode

Set `PROVIDER=mock` in `.env` and restart to fill the app with 14 days of synthetic
data — handy for a look around before real history accumulates. Set it back to
`google-flights` to go live; mock data is purged automatically and never mixes with
real data. (Scans only run for the active provider, so time in demo mode leaves a
gap in live history.)

### Changing scan times

Scans run at 06:10, 11:10, 17:10, 22:10 in the timezone hardcoded in
`server/src/scanner/scheduler.ts` (`TIMEZONE` / `BATCH_CRON`). Edit those and the
matching `TZ=` in the service unit if you want a different schedule, then rebuild.

### Updating to a new version

```bash
cd /opt/rate-pirate
git pull
npm ci && npm run build
sudo systemctl restart rate-pirate
```

### Troubleshooting

| Symptom | Check |
|---|---|
| App unreachable | On the server, `curl localhost:3789/api/health`. If that works, it's a Tailscale/nginx issue; if not, `systemctl status rate-pirate`. |
| Scans failing | **Settings → Activity log** shows each error. Occasional transient failures are normal (retried next batch). Many in a row usually mean Google changed its page or is challenging your IP — lower the daily call budget. |
| No deals showing | Is scanning on and `callsToday` climbing (Settings → Status)? There may simply be no deals right now — lower the alert threshold or deal feed floor under Advanced. |
| No alert emails | Send a test email and read the error. Alerts also require the minimum discount (default 20%), not just a high score. |
| Service won't start | `journalctl -u rate-pirate -n 50`. Usually a missing `.env`, or `node`/`chromium` not installed. |
| Chromium won't launch (sandbox errors) | Set `CHROME_NO_SANDBOX=true` in `.env` and restart (needed on some containers/kernels). |

### Local development

```bash
npm run dev        # server :3789 + Vite UI :5173 (mock provider by default)
npm test           # unit tests, no network
```

Architecture and internals are in [CLAUDE.md](CLAUDE.md). (`DESIGN.md` predates the
Explore rewrite — treat its scanning/schema sections as historical.)
