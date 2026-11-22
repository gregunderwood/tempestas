#!/usr/bin/env bash
# tools/deploy.sh [--allow-irreversible] [host]
# Builds here because a build on the Pi puts the burner controller in reach of the OOM killer.
# Ships a release beside the live one, backs up, migrates, switches, and rolls back if it is not healthy.

set -euo pipefail

HOST="elantris"
IS_IRREVERSIBLE_ALLOWED=false
USAGE="Usage: tools/deploy.sh [--allow-irreversible] [host]"
for argument in "$@"; do
  case "$argument" in
    --allow-irreversible) IS_IRREVERSIBLE_ALLOWED=true ;;
    -*)
      echo "Unknown option $argument. $USAGE" >&2
      exit 2
      ;;
    *) HOST="$argument" ;;
  esac
done
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

source "$HERE/tools/lib/console.sh"
source "$HERE/tools/lib/remote-host.sh"
source "$HERE/tools/lib/release.sh"

# The release stays on disk for a retry; only `migrator` goes back, so a hand-run migration uses live code.
stop_before_switching() {
  point_link_at_release "$HOST" migrator "$PREVIOUS_RELEASE_ID"
  echo "Nothing was switched: $HOST still runs $PREVIOUS_RELEASE_ID. $*" >&2
  exit 1
}

migrate_or_back_up() {
  local show_status=0
  run_oneshot "$HOST" tempestas-migrate@show.service || show_status=$?
  case "$show_status" in
    0)
      say "No migrations; backing up anyway"
      run_oneshot "$HOST" tempestas-backup.service || stop_before_switching "The backup failed."
      record_backup_before_migrations "$HOST" "$RELEASE_ID"
      ;;
    "$EXIT_IRREVERSIBLE_MIGRATIONS_PENDING")
      "$IS_IRREVERSIBLE_ALLOWED" || stop_before_switching \
        "A pending migration cannot be reverted (named above). Deploy with --allow-irreversible once you mean it."
      apply_pending_migrations
      ;;
    "$EXIT_MIGRATIONS_PENDING") apply_pending_migrations ;;
    *) stop_before_switching "Could not check the migrations (status $show_status)." ;;
  esac
}

# migrate@run takes its own backup first, and applies everything in one transaction.
apply_pending_migrations() {
  local run_status=0
  say "Backing up and migrating with $RELEASE_ID's code"
  run_oneshot "$HOST" tempestas-migrate@run.service || run_status=$?
  case "$run_status" in
    0) record_backup_before_migrations "$HOST" "$RELEASE_ID" ;;
    "$EXIT_MIGRATIONS_APPLIED_BUT_NOT_RECORDED")
      stop_before_switching "The migrations were applied but not recorded, so no rollback could undo them; $PREVIOUS_RELEASE_ID now runs on the new schema."
      ;;
    *) stop_before_switching "The migrations failed, and ran as one transaction, so none of them were applied." ;;
  esac
}

say "Gate"
(cd "$HERE" && npx nx run-many -t lint,typecheck,test,build,migration-round-trip)

say "Building the web bundle"
(cd "$HERE" && npx nx build web)

# Two controllers heartbeating one node is two writers on one relay; LISTEN only, as a tab is a client.
if lsof -ti tcp:7000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "A server is listening on :7000 here. Stop it first - only one" >&2
  echo "controller may hold the heartbeat. See docs/Safety.md." >&2
  exit 1
fi

say "Checking $HOST is ready for a release"
require_passwordless_systemctl "$HOST" "${RELEASE_SYSTEMCTL_LINES[@]}"
require_release_layout "$HOST"

RELEASE_ID="$(describe_release_id "$HERE")"
PREVIOUS_RELEASE_ID="$(read_release_behind "$HOST" current)"

say "Shipping $RELEASE_ID beside $PREVIOUS_RELEASE_ID"
ship_release "$HOST" "$RELEASE_ID" "$PREVIOUS_RELEASE_ID" "$HERE"
point_link_at_release "$HOST" migrator "$RELEASE_ID"

say "Migrations"
migrate_or_back_up

say "Switching to $RELEASE_ID"
point_link_at_release "$HOST" current "$RELEASE_ID"
restart_server "$HOST"

if ! wait_until_healthy "$HOST" "$RELEASE_ID"; then
  if roll_back_release "$HOST" "$RELEASE_ID" "$PREVIOUS_RELEASE_ID"; then
    echo "$RELEASE_ID failed its health check and was rolled back to $PREVIOUS_RELEASE_ID. It stays in $REMOTE_ROOT/releases for a look until the next deploy prunes it." >&2
  else
    echo "$RELEASE_ID failed its health check, and the rollback did not finish: what $HOST runs now is above." >&2
  fi
  exit 1
fi

mark_release_healthy "$HOST" "$RELEASE_ID"
prune_releases "$HOST"
say "$HOST runs $RELEASE_ID"
