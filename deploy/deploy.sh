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

# Load git-ignored local overrides if present, so you don't have to pass the
# real host/path every time. Copy deploy/deploy.local.example → deploy/deploy.local
# and set HOST/DEST there (deploy.local is gitignored — real infra stays out of git).
# A HOST=… on the command line still wins over the file.
[ -f deploy/deploy.local ] && . deploy/deploy.local

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
# -t: sudo needs a terminal to prompt for the password. To make deploys
# non-interactive, add a sudoers drop-in on the host:
#   echo 'ryan ALL=(root) NOPASSWD: /usr/bin/systemctl restart rate-pirate' | sudo tee /etc/sudoers.d/rate-pirate
ssh -t "$HOST" "cd $DEST && npm ci --omit=dev && sudo systemctl restart rate-pirate"

echo "==> smoke check"
sleep 3
ssh "$HOST" "curl -sf http://127.0.0.1:3789/api/health && curl -sf http://127.0.0.1:3789/api/status | head -c 200"
echo
echo "deployed — open http://$HOST:8081"
