#!/usr/bin/env bash
# Build locally and deploy to your-server.local:/opt/rate-pirate.
# First-time host setup (once):
#   - Node 22 LTS via NodeSource, rsync
#   - .env at /opt/rate-pirate/.env (copy .env.example and fill keys)
#   - deploy/rate-pirate.service and deploy/nginx.conf (see comments in each)
#   - nightly DB backup, e.g. crontab:
#       15 2 * * * sqlite3 /opt/rate-pirate/data/rate-pirate.db ".backup /opt/rate-pirate/data/backup-$(date +\%w).db"
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=${HOST:-your-server.local}
DEST=${DEST:-/opt/rate-pirate}

echo "==> build"
npm run build

echo "==> sync to $HOST:$DEST"
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .env --exclude .git \
  --exclude ui-samples --exclude '*.db*' \
  ./ "$HOST:$DEST/"

echo "==> install deps + restart"
ssh "$HOST" "cd $DEST && npm ci --omit=dev && sudo systemctl restart rate-pirate"

echo "==> smoke check"
sleep 3
ssh "$HOST" "curl -sf http://127.0.0.1:3789/api/health && curl -sf http://127.0.0.1:3789/api/status | head -c 200"
echo
echo "deployed — open http://$HOST:8081"
