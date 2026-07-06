#!/usr/bin/env bash
# Pull Rate Pirate's nightly DB backups off the host, so a disk/pool failure on
# your-server.local can't take the live DB and every backup with it. Run from another
# machine (e.g. the macOS dev box), manually or via cron/launchd:
#   0 8 * * * /path/to/rate-pirate/deploy/pull-backups.sh
set -euo pipefail
HOST=${HOST:-your-server.local}
DEST=${DEST:-"$HOME/rate-pirate-backups"}

mkdir -p "$DEST"
rsync -az "$HOST:/opt/rate-pirate/data/backup-*.db" "$DEST/"
echo "backups synced to $DEST:"
ls -lh "$DEST"
