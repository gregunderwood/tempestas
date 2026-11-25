# Sourced by tools/deploy.sh and tools/rollback.sh; the layout is in docs/Infrastructure/Deploys.md.

# Overridable only so tests can stand a local directory in for the host.
REMOTE_ROOT="${TEMPESTAS_REMOTE_ROOT:-/home/gunderwood/tempestas}"
HEALTH_URL="http://127.0.0.1:7000/api/health"
HEALTH_TIMEOUT_SECONDS=60
HEALTH_POLL_SECONDS=2
HEALTH_REQUEST_TIMEOUT_SECONDS=5
BACKUP_JOURNAL_LINES=50
COMMIT_ID_LENGTH=7
KEPT_RELEASES=3
HEALTHY_MARKER=healthy
BACKUP_RECORD=backup-before-migrations
PREVIOUS_RECORD=previous-release
EXIT_MIGRATIONS_PENDING=3
EXIT_IRREVERSIBLE_MIGRATIONS_PENDING=4
EXIT_MIGRATIONS_APPLIED_BUT_NOT_RECORDED=5
RELEASE_SYSTEMCTL_LINES=(
  "start tempestas-migrate@show.service"
  "start tempestas-migrate@run.service"
  "start tempestas-migrate@revert-applied.service"
  "start tempestas-backup.service"
  "stop tempestas-server.service"
  "reset-failed tempestas-server.service"
  "restart tempestas-server.service"
)

# <UTC time to the second>-<commit>, marked -dev off a clean origin/main, as the agents are.
describe_release_id() {
  local repository="$1"
  local stamp commit released_commit
  if ! git -C "$repository" fetch --quiet --tags origin main 2>/dev/null; then
    echo "Could not fetch origin/main and its tags, so the release ID and product version use the last fetch." >&2
  fi
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  commit="$(git -C "$repository" rev-parse --short="$COMMIT_ID_LENGTH" HEAD)"
  released_commit="$(git -C "$repository" rev-parse --short="$COMMIT_ID_LENGTH" --verify --quiet origin/main || true)"
  if [ -n "$(git -C "$repository" status --porcelain)" ]; then
    echo "$stamp-$commit-dev-dirty"
  elif [ "$commit" != "$released_commit" ]; then
    echo "$stamp-$commit-dev"
  else
    echo "$stamp-$commit"
  fi
}

require_release_layout() {
  local host="$1"
  if ! ssh "$host" "test -L $REMOTE_ROOT/current && test -L $REMOTE_ROOT/migrator && systemctl cat tempestas-server.service | grep -q '$REMOTE_ROOT/current/server/main.js'"; then
    echo "$host does not run its server from $REMOTE_ROOT/current yet." >&2
    echo "Run tools/install-deploy-privileges.sh $host once: it moves dist/ into a release and points the units at it." >&2
    exit 1
  fi
}

read_release_behind() {
  local host="$1" link="$2"
  ssh "$host" "readlink $REMOTE_ROOT/$link" | xargs -r basename
}

# Apart only when a revert failed or a deploy was cut short; moving migrator then loses the record of what is applied.
require_migrator_on_current() {
  local host="$1" current_release_id migrator_release_id
  current_release_id="$(read_release_behind "$host" current)"
  migrator_release_id="$(read_release_behind "$host" migrator)"
  if [ "$current_release_id" = "$migrator_release_id" ]; then
    return
  fi
  echo "$host runs $current_release_id, but migrator is on $migrator_release_id: a revert failed or a deploy was cut short." >&2
  echo "Once $migrator_release_id's migrations are reverted, or were never applied, point migrator back:" >&2
  echo "  ssh $host 'sudo systemctl start tempestas-migrate@revert-applied.service && cd $REMOTE_ROOT && ln -sfn releases/$current_release_id migrator'" >&2
  echo "Or keep them applied, as expand-contract allows and an irreversible one needs, and give up undoing them:" >&2
  echo "  ssh $host 'cd $REMOTE_ROOT && ln -sfn releases/$current_release_id migrator'" >&2
  exit 1
}

# Renamed into place, so the link is never missing for an instant.
point_link_at_release() {
  local host="$1" link="$2" release_id="$3"
  ssh "$host" "cd $REMOTE_ROOT && ln -sfn releases/$release_id .$link.next && mv -T .$link.next $link"
}

# The release that ran when this one shipped: the only one whose schema reverting this release's migrations leaves.
read_previous_release() {
  local host="$1" release_id="$2"
  ssh "$host" "cd $REMOTE_ROOT/releases && previous_release_id=\"\$(cat $release_id/$PREVIOUS_RECORD 2>/dev/null)\" && test -d \"\$previous_release_id\" && echo \"\$previous_release_id\"" || true
}

mark_release_healthy() {
  local host="$1" release_id="$2"
  ssh "$host" "touch $REMOTE_ROOT/releases/$release_id/$HEALTHY_MARKER"
}

is_release_healthy() {
  local host="$1" release_id="$2"
  ssh "$host" "test -e $REMOTE_ROOT/releases/$release_id/$HEALTHY_MARKER"
}

# Node modules are hard-linked from the previous release when the lockfile has not changed.
ship_release() {
  local host="$1" release_id="$2" previous_release_id="$3" repository="$4" product_version="$5"
  local release_dir="$REMOTE_ROOT/releases/$release_id"
  if ssh "$host" "test -e $release_dir"; then
    echo "$release_dir already exists on $host; a release is never shipped over." >&2
    exit 1
  fi
  ssh "$host" "mkdir -p $release_dir"
  rsync -a "$repository/dist/apps/server/" "$host:$release_dir/server/"
  rsync -a "$repository/dist/apps/web/browser/" "$host:$release_dir/web/"
  ssh "$host" bash -s -- "$release_dir" "$release_id" "$previous_release_id" "$PREVIOUS_RECORD" "$product_version" <<'REMOTE'
set -euo pipefail
release_dir="$1" release_id="$2" previous_release_id="$3" previous_record="$4" product_version="$5"
previous_release_dir="$(dirname "$release_dir")/$previous_release_id"
echo "$release_id" >"$release_dir/release-id"
echo "$product_version" >"$release_dir/product-version"
echo "$previous_release_id" >"$release_dir/$previous_record"
cd "$release_dir/server"
if [ -d "$previous_release_dir/server/node_modules" ] &&
  cmp -s package-lock.json "$previous_release_dir/server/package-lock.json"; then
  cp -al "$previous_release_dir/server/node_modules" node_modules
else
  /usr/local/bin/npm ci --omit=dev --no-audit --no-fund
fi
REMOTE
}

# Exits with the unit's own status; a stale status from an earlier run, or a signal, reads as 1.
run_oneshot() {
  local host="$1" unit="$2"
  ssh "$host" bash -s -- "$unit" <<'REMOTE'
unit="$1"
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

stop_server() {
  ssh "$1" "sudo -n systemctl stop tempestas-server.service"
}

# A server that crash-looped into its start limit refuses a plain restart.
restart_server() {
  ssh "$1" "sudo -n systemctl reset-failed tempestas-server.service; sudo -n systemctl restart tempestas-server.service"
}

wait_until_healthy() {
  local host="$1" release_id="$2"
  ssh "$host" bash -s -- "$release_id" "$HEALTH_URL" "$HEALTH_TIMEOUT_SECONDS" \
    "$HEALTH_POLL_SECONDS" "$HEALTH_REQUEST_TIMEOUT_SECONDS" <<'REMOTE'
release_id="$1" health_url="$2" timeout_seconds="$3" poll_seconds="$4" request_timeout_seconds="$5"
deadline=$((SECONDS + timeout_seconds))
reports_own_release() { grep -q "\"releaseId\":\"$release_id\"" <<<"$1"; }
reports_no_release() { ! grep -q '"releaseId":"' <<<"$1"; }
# The release install-deploy-privileges.sh made from dist/ may predate releaseId, and then only its database answers for it.
reports_release() {
  case "$release_id" in
    *-before-releases) reports_own_release "$1" || reports_no_release "$1" ;;
    *) reports_own_release "$1" ;;
  esac
}
report=""
while [ "$SECONDS" -lt "$deadline" ]; do
  report="$(curl -fsS --max-time "$request_timeout_seconds" "$health_url" 2>/dev/null || true)"
  if grep -q '"db":true' <<<"$report" && reports_release "$report"; then
    echo "$release_id is up, and its database answers."
    exit 0
  fi
  sleep "$poll_seconds"
done
echo "$release_id was not healthy within ${timeout_seconds}s. Last report: ${report:-none}" >&2
exit 1
REMOTE
}

# Asks the database, because a dropped ssh or a failed record can make an exit status say the wrong thing.
read_migration_state() {
  local host="$1" show_status=0
  run_oneshot "$host" tempestas-migrate@show.service >&2 || show_status=$?
  case "$show_status" in
    0) echo applied ;;
    "$EXIT_MIGRATIONS_PENDING" | "$EXIT_IRREVERSIBLE_MIGRATIONS_PENDING") echo pending ;;
    *) echo unknown ;;
  esac
}

read_newest_backup() {
  ssh "$1" "journalctl -u tempestas-backup.service -n $BACKUP_JOURNAL_LINES -o cat" | sed -n 's/^Backup written: \([^ ]*\).*/\1/p' | tail -n 1
}

# Kept in the release, because a later backup in the journal can already hold this release's schema.
record_backup_before_migrations() {
  local host="$1" release_id="$2"
  local backup
  backup="$(read_newest_backup "$host")" || backup=""
  if [ -z "$backup" ] ||
    ! ssh "$host" "printf '%s\n' $(printf '%q' "$backup") >$REMOTE_ROOT/releases/$release_id/$BACKUP_RECORD"; then
    echo "Could not record which backup came before $release_id's migrations; a restore hint for it will name none." >&2
  fi
}

print_restore_instructions() {
  local host="$1" failing_release_id="$2" target_release_id="$3"
  local backup
  backup="$(ssh "$host" "cat $REMOTE_ROOT/releases/$failing_release_id/$BACKUP_RECORD 2>/dev/null" || true)"
  backup="${backup:-<the dump taken before $failing_release_id migrated, in /var/backups/tempestas>}"
  echo "Restoring is never automatic: it also discards everything written since the backup." >&2
  echo "If you decide to, restore $backup, taken before $failing_release_id migrated, and run $target_release_id, whose schema it has:" >&2
  echo "  ssh -t $host 'sudo systemctl stop tempestas-server.service && sudo -u postgres pg_restore --clean --if-exists --dbname tempestas $backup && cd $REMOTE_ROOT && ln -sfn releases/$target_release_id current && ln -sfn releases/$target_release_id migrator && sudo systemctl start tempestas-server.service'" >&2
}

# A stopped server lets every node's dead-man fire; the pumphouse heater is not a thing to leave off.
# Expand-contract lets either release run on this schema, so the one that passed its health check runs.
keep_a_release_running() {
  local host="$1" failing_release_id="$2" target_release_id="$3" why="$4"
  local running_release_id="$target_release_id"
  if is_release_healthy "$host" "$failing_release_id"; then
    running_release_id="$failing_release_id"
  fi
  echo "$why Restarting $running_release_id, the one of the two that passed its health check." >&2
  point_link_at_release "$host" migrator "$failing_release_id" || true
  point_link_at_release "$host" current "$running_release_id" || true
  restart_server "$host" || true
  wait_until_healthy "$host" "$running_release_id" || true
  print_retry_instructions "$host" "$failing_release_id" "$target_release_id" "$running_release_id"
  print_restore_instructions "$host" "$failing_release_id" "$target_release_id"
}

print_retry_instructions() {
  local host="$1" failing_release_id="$2" target_release_id="$3" running_release_id="$4"
  if [ "$running_release_id" = "$failing_release_id" ]; then
    echo "Once the revert can run, tools/rollback.sh $host tries again." >&2
    return
  fi
  echo "Once the revert can run, retry it with $failing_release_id's code, which migrator still points at:" >&2
  echo "  ssh $host 'sudo systemctl start tempestas-migrate@revert-applied.service && cd $REMOTE_ROOT && ln -sfn releases/$target_release_id migrator'" >&2
}

# Reverts with the failing release's code; every step is checked, as a caller's `if` turns `set -e` off in here.
roll_back_release() {
  local host="$1" failing_release_id="$2" target_release_id="$3"
  say "Rolling back from $failing_release_id to $target_release_id"
  if ! stop_server "$host"; then
    echo "Could not stop the server, so nothing was reverted and $failing_release_id still runs." >&2
    return 1
  fi
  if ! point_link_at_release "$host" migrator "$failing_release_id"; then
    keep_a_release_running "$host" "$failing_release_id" "$target_release_id" \
      "Could not point migrator at $failing_release_id, so nothing was reverted."
    return 1
  fi
  if ! run_oneshot "$host" tempestas-migrate@revert-applied.service; then
    case "$(read_migration_state "$host")" in
      pending)
        echo "The revert reported a failure, but $failing_release_id's migrations are no longer applied, so the rollback goes on." >&2
        ;;
      applied)
        keep_a_release_running "$host" "$failing_release_id" "$target_release_id" \
          "The revert did not run, so the schema is still $failing_release_id's."
        return 1
        ;;
      *)
        keep_a_release_running "$host" "$failing_release_id" "$target_release_id" \
          "Could not tell whether the revert ran; check: ssh $host journalctl -u tempestas-migrate@revert-applied.service -n 50."
        return 1
        ;;
    esac
  fi
  if ! point_link_at_release "$host" current "$target_release_id" ||
    ! point_link_at_release "$host" migrator "$target_release_id"; then
    echo "The revert ran, so the schema is $target_release_id's, but the links did not move and the server is stopped. Finish by hand:" >&2
    echo "  ssh $host 'cd $REMOTE_ROOT && ln -sfn releases/$target_release_id current && ln -sfn releases/$target_release_id migrator && sudo systemctl restart tempestas-server.service'" >&2
    return 1
  fi
  if ! restart_server "$host" || ! wait_until_healthy "$host" "$target_release_id"; then
    echo "$target_release_id did not come back healthy either. Check: ssh $host journalctl -u tempestas-server.service -n 50" >&2
    return 1
  fi
}

# `current` and the releases a rollback.sh would go back through from it, and whatever `migrator` points at.
prune_releases() {
  local host="$1"
  ssh "$host" bash -s -- "$REMOTE_ROOT" "$KEPT_RELEASES" "$PREVIOUS_RECORD" <<'REMOTE'
set -euo pipefail
root="$1" kept_releases="$2" previous_record="$3"
cd "$root/releases"
kept=" $(basename "$(readlink "$root/migrator")") "
kept_count=0
chained_release_id="$(basename "$(readlink "$root/current")")"
while [ -n "$chained_release_id" ] && [ "$kept_count" -lt "$kept_releases" ]; do
  kept="$kept$chained_release_id "
  kept_count=$((kept_count + 1))
  chained_release_id="$(cat "$chained_release_id/$previous_record" 2>/dev/null || true)"
done
for release_id in *; do
  case "$kept" in
    *" $release_id "*) ;;
    *) rm -rf -- "$release_id" ;;
  esac
done
REMOTE
}
