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
source "$HERE/apps/agent-linux/agent-files.sh"
source "$HERE/apps/agent-micropython/agent-files.sh"
source "$HERE/tools/lib/agent-bundle.sh"
AGENT_BUNDLES_DIR="$HERE/dist/$AGENT_RELEASES_DIRECTORY"

# The release stays on disk for a retry; only `migrator` goes back, so a hand-run migration uses live code.
stop_before_switching() {
  point_link_at_release "$HOST" migrator "$PREVIOUS_RELEASE_ID"
  echo "Nothing was switched: $HOST still runs $PREVIOUS_RELEASE_ID. $*" >&2
  exit 1
}

# migrator stays on the new release, whose record a revert needs, so the next deploy refuses until it is resolved.
stop_leaving_migrator_on_release() {
  echo "Nothing was switched: $HOST still runs $PREVIOUS_RELEASE_ID, and migrator stays on $RELEASE_ID. $*" >&2
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
    *) stop_after_failed_run "$run_status" ;;
  esac
}

stop_after_failed_run() {
  local run_status="$1"
  local journal="ssh $HOST journalctl -u tempestas-migrate@run.service -u tempestas-backup.service -n 50"
  case "$(read_migration_state "$HOST")" in
    pending)
      stop_before_switching "The backup or the migrations failed (status $run_status). They run as one transaction, so none were applied."
      ;;
    applied)
      stop_leaving_migrator_on_release "The run reported status $run_status, but the migrations are applied, so $PREVIOUS_RELEASE_ID now runs on the new schema. Check: $journal"
      ;;
    *) stop_leaving_migrator_on_release "Could not tell whether the migrations ran (status $run_status). Check: $journal" ;;
  esac
}

say "Checking $HOST is ready for a release"
require_passwordless_systemctl "$HOST" "${RELEASE_SYSTEMCTL_LINES[@]}"
require_release_layout "$HOST"
require_migrator_on_current "$HOST"

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

fetch_main_and_tags "$HERE"
RELEASE_ID="$(describe_release_id "$HERE")"
PRODUCT_VERSION="$("$HERE/tools/describe-product-version.sh" "$HERE")"
PREVIOUS_RELEASE_ID="$(read_release_behind "$HOST" current)"

say "Bundling the agents for the server to offer"
build_agent_bundles "$HERE" "$RELEASE_ID" "$AGENT_BUNDLES_DIR"

say "Shipping $RELEASE_ID ($PRODUCT_VERSION) beside $PREVIOUS_RELEASE_ID"
ship_release "$HOST" "$RELEASE_ID" "$PREVIOUS_RELEASE_ID" "$HERE" "$PRODUCT_VERSION"
ship_agent_bundles "$HOST" "$AGENT_BUNDLES_DIR"
# Before the restart, as the server reads the bundles once when it starts.
prune_agent_bundles "$HOST" || echo "Could not prune old agent bundles on $HOST; the next deploy tries again." >&2
point_link_at_release "$HOST" migrator "$RELEASE_ID"

say "Migrations"
migrate_or_back_up

say "Switching to $RELEASE_ID"
if ! point_link_at_release "$HOST" current "$RELEASE_ID" ||
  ! restart_server "$HOST" ||
  ! wait_until_healthy "$HOST" "$RELEASE_ID"; then
  if roll_back_release "$HOST" "$RELEASE_ID" "$PREVIOUS_RELEASE_ID"; then
    echo "$RELEASE_ID did not come up healthy and was rolled back to $PREVIOUS_RELEASE_ID. It stays in $REMOTE_ROOT/releases for a look until the next deploy prunes it." >&2
  else
    echo "$RELEASE_ID did not come up healthy, and the rollback did not finish: what $HOST runs now is above." >&2
  fi
  exit 1
fi

if ! mark_release_healthy "$HOST" "$RELEASE_ID"; then
  echo "$RELEASE_ID runs, but could not be marked healthy, so a rollback whose revert fails restarts $PREVIOUS_RELEASE_ID rather than it." >&2
fi
prune_releases "$HOST" || echo "Could not prune old releases on $HOST; the next deploy tries again." >&2
say "$HOST runs $RELEASE_ID"
