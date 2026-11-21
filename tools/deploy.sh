#!/usr/bin/env bash
# tools/deploy.sh [host]
# Builds here because a build on the Pi puts the burner controller in reach of the OOM killer.

set -euo pipefail

HOST="${1:-elantris}"
REMOTE="/home/gunderwood/tempestas"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# Exactly the command lines tools/install-deploy-privileges.sh allows, so none of them asks for a password.
run_unit_and_show_output() {
  local unit="$1"
  ssh -t "$HOST" "sudo systemctl start $unit; journalctl -o cat _SYSTEMD_INVOCATION_ID=\$(systemctl show -p InvocationID --value $unit)"
}

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

# Checked before the restart: the new code on an unmigrated schema crash-loops the server.
say "Migrations"
MIGRATIONS="$(run_unit_and_show_output tempestas-migrate@show.service)"
echo "$MIGRATIONS"
if grep -q '^\[ \]' <<<"$MIGRATIONS"; then
  echo "Migrations are pending, so the server was NOT restarted. Back up, run them, then restart:" >&2
  echo "  ssh -t $HOST sudo systemctl start tempestas-backup.service" >&2
  echo "  ssh -t $HOST sudo systemctl start tempestas-migrate@run.service" >&2
  echo "  ssh -t $HOST sudo systemctl restart tempestas-server.service" >&2
  exit 1
fi

say "Restarting"
ssh -t "$HOST" "sudo systemctl restart tempestas-server.service && sleep 3 && systemctl is-active tempestas-server"
