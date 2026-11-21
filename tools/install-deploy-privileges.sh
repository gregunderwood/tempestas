#!/usr/bin/env bash
# tools/install-deploy-privileges.sh [host ...]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_PAYLOAD="/home/gunderwood/tempestas/install/deploy-privileges"
PAYLOAD_FILES=(
  "$HERE/tools/lib/console.sh"
  "$HERE/apps/server/systemd/tempestas-migrate-requires-backup.conf"
  "$HERE/tools/host/install-deploy-privileges.sh"
  "$HERE/tools/host/backup-database.sh"
  "$HERE/apps/server/systemd/tempestas-backup.service"
)

source "$HERE/tools/lib/console.sh"
source "$HERE/tools/lib/remote-host.sh"

HOSTS=("$@")
[ "$#" -gt 0 ] || HOSTS=("${LINUX_HOSTS[@]}")

for HOST in "${HOSTS[@]}"; do
  say "$HOST"
  ssh "$HOST" "mkdir -p $REMOTE_PAYLOAD"
  rsync -a --delete "${PAYLOAD_FILES[@]}" "$HOST:$REMOTE_PAYLOAD/"
  ssh -t "$HOST" "sudo bash $REMOTE_PAYLOAD/install-deploy-privileges.sh $REMOTE_PAYLOAD"
done
