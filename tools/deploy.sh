#!/usr/bin/env bash
# tools/deploy.sh [host]
# Builds here because a build on the Pi puts the burner controller in reach of the OOM killer.

set -euo pipefail

HOST="${1:-elantris}"
REMOTE="/home/gunderwood/tempestas"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

EXIT_MIGRATIONS_PENDING=3
REQUIRED_SUDO_COMMANDS=(
  "/usr/bin/systemctl start tempestas-migrate@show.service"
  "/usr/bin/systemctl restart tempestas-server.service"
)

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# Checked up front: a missing rule would otherwise stop the deploy at a password prompt it cannot show.
require_passwordless_sudo() {
  for command in "${REQUIRED_SUDO_COMMANDS[@]}"; do
    if ! ssh "$HOST" "sudo -n -l $command" >/dev/null 2>&1; then
      echo "$HOST will not run '$command' without a password." >&2
      echo "Run tools/install-deploy-privileges.sh $HOST first." >&2
      exit 1
    fi
  done
}

# Prints migrate:show's output and exits with its status. A unit that failed before node ran reads as 1, never 0.
show_migrations() {
  ssh "$HOST" '
    cursor="$(journalctl --show-cursor -n 0 -o cat | sed -n "s/^-- cursor: //p")"
    if sudo -n systemctl start tempestas-migrate@show.service; then
      status=0
    else
      status="$(systemctl show -p ExecMainStatus --value tempestas-migrate@show.service)"
      [ "${status:-0}" != 0 ] || status=1
    fi
    journalctl -u tempestas-migrate@show.service --after-cursor="$cursor" -o cat
    exit "$status"'
}

warn_new_build_not_running() {
  echo "The new build is on $HOST but the old server is still running it from memory." >&2
  echo "If that server restarts before this is resolved, it starts the new code and may crash-loop." >&2
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

say "Checking $HOST lets this deploy run without a password"
require_passwordless_sudo

say "Shipping to $HOST"
rsync -a --delete "$HERE/dist/apps/server/" "$HOST:$REMOTE/dist/apps/server/"
rsync -a --delete "$HERE/dist/apps/web/browser/" "$HOST:$REMOTE/dist/apps/web/"
rsync -a "$HERE/apps/server/systemd/" "$HOST:$REMOTE/apps/server/systemd/"
rsync -a "$HERE/apps/agent-linux/systemd/" "$HOST:$REMOTE/apps/agent-linux/systemd/"

say "Installing runtime dependencies"
ssh "$HOST" "cd $REMOTE/dist/apps/server && /usr/local/bin/npm ci --omit=dev --no-audit --no-fund"

# Checked before the restart: the new code on an unmigrated schema crash-loops the server.
say "Migrations"
if show_migrations; then
  migration_status=0
else
  migration_status=$?
fi

if [ "$migration_status" -eq "$EXIT_MIGRATIONS_PENDING" ]; then
  echo "Migrations are pending, so the server was NOT restarted. Back up, run them, then restart:" >&2
  echo "  ssh -t $HOST sudo systemctl start tempestas-backup.service" >&2
  echo "  ssh -t $HOST sudo systemctl start tempestas-migrate@run.service" >&2
  echo "  ssh -t $HOST sudo systemctl restart tempestas-server.service" >&2
  warn_new_build_not_running
  exit 1
fi
if [ "$migration_status" -ne 0 ]; then
  echo "Could not check the migrations (status $migration_status), so the server was NOT restarted." >&2
  echo "  ssh $HOST journalctl -u tempestas-migrate@show.service -n 30 -o cat" >&2
  warn_new_build_not_running
  exit 1
fi

say "Restarting"
ssh "$HOST" "sudo -n systemctl restart tempestas-server.service && sleep 3 && systemctl is-active tempestas-server"
