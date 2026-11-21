#!/usr/bin/env bash
# tools/deploy.sh [host]
# Builds here because a build on the Pi puts the burner controller in reach of the OOM killer.

set -euo pipefail

HOST="${1:-elantris}"
REMOTE="/home/gunderwood/tempestas"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

EXIT_MIGRATIONS_PENDING=3
REQUIRED_SYSTEMCTL_LINES=(
  "start tempestas-migrate@show.service"
  "reset-failed tempestas-server.service"
  "restart tempestas-server.service"
)

source "$HERE/tools/lib/remote-host.sh"

source "$HERE/tools/lib/console.sh"

# A stale status from an earlier run, or a signal number, must never read as "pending" or "nothing pending".
show_migrations_and_exit_with_their_status() {
  ssh "$HOST" bash -s <<'REMOTE'
unit=tempestas-migrate@show.service
read_property() { systemctl show -p "$1" --value "$unit"; }
EXITED_NORMALLY=1
COULD_NOT_CHECK=1
started_before="$(read_property ExecMainStartTimestampMonotonic)"
checked_since="$(date +%s)"
ran_this_time_and_exited_normally() {
  [ "$(read_property ExecMainStartTimestampMonotonic)" != "$started_before" ] &&
    [ "$(read_property ExecMainCode)" = "$EXITED_NORMALLY" ]
}
if sudo -n systemctl start "$unit"; then
  status=0
elif ran_this_time_and_exited_normally; then
  status="$(read_property ExecMainStatus)"
  [ "$status" != 0 ] || status="$COULD_NOT_CHECK"
else
  status="$COULD_NOT_CHECK"
fi
journalctl -u "$unit" --since "@$checked_since" -o cat
exit "$status"
REMOTE
}

warn_new_build_not_running() {
  echo "The new build is on $HOST but the old server is still running it from memory." >&2
  echo "If that server restarts before this is resolved, it starts the new code and may crash-loop." >&2
}

say "Gate"
(cd "$HERE" && npx nx run-many -t lint,test,build,migration-round-trip)

say "Building the web bundle"
(cd "$HERE" && npx nx build web)

# Two controllers heartbeating one node is two writers on one relay; LISTEN only, as a tab is a client.
if lsof -ti tcp:7000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "A server is listening on :7000 here. Stop it first - only one" >&2
  echo "controller may hold the heartbeat. See docs/Safety.md." >&2
  exit 1
fi

say "Checking $HOST lets this deploy run without a password"
require_passwordless_systemctl "$HOST" "${REQUIRED_SYSTEMCTL_LINES[@]}"

say "Shipping to $HOST"
rsync -a --delete "$HERE/dist/apps/server/" "$HOST:$REMOTE/dist/apps/server/"
rsync -a "$HERE/apps/server/systemd/" "$HOST:$REMOTE/apps/server/systemd/"
rsync -a "$HERE/apps/agent-linux/systemd/" "$HOST:$REMOTE/apps/agent-linux/systemd/"

say "Installing runtime dependencies"
ssh "$HOST" "cd $REMOTE/dist/apps/server && /usr/local/bin/npm ci --omit=dev --no-audit --no-fund"

# Checked before the restart: the new code on an unmigrated schema crash-loops the server.
say "Migrations"
if show_migrations_and_exit_with_their_status; then
  migration_status=0
else
  migration_status=$?
fi

if [ "$migration_status" -eq "$EXIT_MIGRATIONS_PENDING" ]; then
  echo "Migrations are pending, so the server was NOT restarted and the web bundle was not shipped." >&2
  echo "Run them, then deploy again. migrate@run backs up first where tempestas-backup.service exists;" >&2
  echo "anywhere else it asks for a password: back up by hand first (docs/Infrastructure/Migrations.md)." >&2
  echo "  ssh $HOST sudo -n systemctl start tempestas-migrate@run.service && tools/deploy.sh $HOST" >&2
  warn_new_build_not_running
  exit 1
fi
if [ "$migration_status" -ne 0 ]; then
  echo "Could not check the migrations (status $migration_status), so the server was NOT restarted." >&2
  echo "  ssh $HOST journalctl -u tempestas-migrate@show.service -n 30 -o cat" >&2
  warn_new_build_not_running
  exit 1
fi

say "Shipping the web bundle"
rsync -a --delete "$HERE/dist/apps/web/browser/" "$HOST:$REMOTE/dist/apps/web/"

say "Restarting"
# A server that crash-looped into its start limit refuses a plain restart.
ssh "$HOST" "sudo -n systemctl reset-failed tempestas-server.service; sudo -n systemctl restart tempestas-server.service && sleep 3 && systemctl is-active tempestas-server"
