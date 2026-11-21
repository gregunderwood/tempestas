#!/usr/bin/env bash
# tools/install-deploy-privileges.sh [host ...]

set -euo pipefail

DEFAULT_HOSTS=(elantris patji)
HOSTS=("$@")
[ "$#" -gt 0 ] || HOSTS=("${DEFAULT_HOSTS[@]}")
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_PAYLOAD="/home/gunderwood/tempestas/install/deploy-privileges"
PAYLOAD_FILES=(
  "$HERE/tools/host/install-deploy-privileges.sh"
  "$HERE/tools/host/backup-database.sh"
  "$HERE/apps/server/systemd/tempestas-backup.service"
)

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

for HOST in "${HOSTS[@]}"; do
  say "$HOST"
  ssh "$HOST" "mkdir -p $REMOTE_PAYLOAD"
  rsync -a --delete "${PAYLOAD_FILES[@]}" "$HOST:$REMOTE_PAYLOAD/"
  ssh -t "$HOST" "sudo bash $REMOTE_PAYLOAD/install-deploy-privileges.sh $REMOTE_PAYLOAD"
done
