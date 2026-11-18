#!/usr/bin/env bash
#
# Deploy the controller to elantris. Build here, ship artifacts, restart there.
#
# Nothing is built on the Pi. An Angular production build peaks at 1.5-2.5 GiB
# on a 3.7 GiB box and would put Postgres and the burner controller in reach of
# the OOM killer - see docs/Safety.md.
#
# Migrations are NOT run: they are a deliberate manual step, because a schema
# change against the only copy of the greenhouse's history deserves a human
# reading `migration:show` first. This script prints the command and stops.
#
#   tools/deploy.sh [host]

set -euo pipefail

HOST="${1:-elantris}"
REMOTE="/home/gunderwood/tempestas"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- refuse to ship something that does not pass ---------------------------
say "Gate"
(cd "$HERE" && npx nx run-many -t lint,test,build)

say "Building the web bundle"
(cd "$HERE" && npx nx build web)

# --- the controller must be singular ---------------------------------------
# Two controllers heartbeating at one node is two writers on one relay. If a
# dev server is up on this Mac it has to go before the Pi's takes over.
# LISTEN only: a browser tab open on the Pi's dashboard also holds a socket on
# :7000, and that is a client, not a second controller.
if lsof -ti tcp:7000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "A server is listening on :7000 here. Stop it first - only one" >&2
  echo "controller may hold the heartbeat. See docs/Safety.md." >&2
  exit 1
fi

say "Shipping to $HOST"
rsync -a --delete "$HERE/dist/apps/server/" "$HOST:$REMOTE/dist/apps/server/"
rsync -a --delete "$HERE/dist/apps/web/browser/" "$HOST:$REMOTE/dist/apps/web/"
rsync -a "$HERE/apps/server/systemd/" "$HOST:$REMOTE/apps/server/systemd/"
rsync -a "$HERE/apps/hardware/systemd/" "$HOST:$REMOTE/apps/hardware/systemd/"

# The server bundle carries a generated manifest of runtime dependencies only,
# so this installs no webpack and no Angular.
say "Installing runtime dependencies"
ssh "$HOST" "cd $REMOTE/dist/apps/server && /usr/local/bin/npm ci --omit=dev --no-audit --no-fund"

say "Restarting"
ssh "$HOST" "sudo systemctl restart tempestas-server && sleep 3 && systemctl is-active tempestas-server"

say "Pending migrations"
echo "Not run by this script. On $HOST:"
echo "  cd $REMOTE && npm run migration:show   # read it first"
echo "  cd $REMOTE && npm run migration:run"
