#!/usr/bin/env bash
# tools/deploy.sh [host]
# Builds here because a build on the Pi puts the burner controller in reach of the OOM killer.

set -euo pipefail

HOST="${1:-elantris}"
REMOTE="/home/gunderwood/tempestas"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATE="sudo systemd-run --quiet --pipe --wait --uid=gunderwood \
-p EnvironmentFile=/etc/tempestas/server.env -E NODE_ENV=production \
/usr/local/bin/node $REMOTE/dist/apps/server/main.js"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Gate"
(cd "$HERE" && npx nx run-many -t lint,test,build)

say "Building the web bundle"
(cd "$HERE" && npx nx build web)

# Two controllers heartbeating one node is two writers on one relay; LISTEN only, as a tab is a client.
if lsof -ti tcp:7000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "A server is listening on :7000 here. Stop it first - only one" >&2
  echo "controller may hold the heartbeat. See docs/Safety.md." >&2
  exit 1
fi

say "Shipping to $HOST"
rsync -a --delete "$HERE/dist/apps/server/" "$HOST:$REMOTE/dist/apps/server/"
rsync -a --delete "$HERE/dist/apps/web/browser/" "$HOST:$REMOTE/dist/apps/web/"
rsync -a "$HERE/apps/server/systemd/" "$HOST:$REMOTE/apps/server/systemd/"
rsync -a "$HERE/apps/agent-linux/systemd/" "$HOST:$REMOTE/apps/agent-linux/systemd/"

say "Installing runtime dependencies"
ssh "$HOST" "cd $REMOTE/dist/apps/server && /usr/local/bin/npm ci --omit=dev --no-audit --no-fund"

say "Restarting"
ssh "$HOST" "sudo systemctl restart tempestas-server && sleep 3 && systemctl is-active tempestas-server"

# Shown, never run: a schema change against the only copy of the history wants a backup first.
say "Migrations (shown, not run)"
ssh "$HOST" "$MIGRATE migrate:show"
echo "To apply any pending above, back up first, then (docs/Infrastructure/Migrations.md):"
echo "  ssh $HOST $MIGRATE migrate:run"
