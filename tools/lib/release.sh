# Sourced by tools/deploy.sh and tools/rollback.sh; the layout is in docs/Infrastructure/Deploys.md.

# Overridable only so tests can stand a local directory in for the host.
REMOTE_ROOT="${TEMPESTAS_REMOTE_ROOT:-/home/gunderwood/tempestas}"
HEALTH_URL="http://127.0.0.1:7000/api/health"
HEALTH_TIMEOUT_SECONDS=60
KEPT_RELEASES=3
HEALTHY_MARKER=healthy
BACKUP_RECORD=backup-before-migrations
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
  if ! git -C "$repository" fetch --quiet origin main 2>/dev/null; then
    echo "Could not fetch origin/main, so the release ID compares against the last fetch." >&2
  fi
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  commit="$(git -C "$repository" rev-parse --short=7 HEAD)"
  released_commit="$(git -C "$repository" rev-parse --short=7 --verify --quiet origin/main || true)"
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
  if ! ssh "$host" "test -L $REMOTE_ROOT/current && systemctl cat tempestas-server.service | grep -q '$REMOTE_ROOT/current/server/main.js'"; then
    echo "$host does not run its server from $REMOTE_ROOT/current yet." >&2
    echo "Run tools/install-deploy-privileges.sh $host once: it moves dist/ into a release and points the units at it." >&2
    exit 1
  fi
}

read_release_behind() {
  local host="$1" link="$2"
  ssh "$host" "readlink $REMOTE_ROOT/$link" | xargs -r basename
}

# Renamed into place, so the link is never missing for an instant.
point_link_at_release() {
  local host="$1" link="$2" release_id="$3"
  ssh "$host" "cd $REMOTE_ROOT && ln -sfn releases/$release_id .$link.next && mv -T .$link.next $link"
}

# Only releases that passed a health check: a failed or half-shipped one is no place to go back to.
list_healthy_releases_older_than() {
  local host="$1" release_id="$2"
  ssh "$host" "cd $REMOTE_ROOT/releases && ls -1d -- */$HEALTHY_MARKER 2>/dev/null" |
    cut -d/ -f1 | sort | awk -v newest="$release_id" '$0 < newest'
}

mark_release_healthy() {
  local host="$1" release_id="$2"
  ssh "$host" "touch $REMOTE_ROOT/releases/$release_id/$HEALTHY_MARKER"
}

# Node modules are hard-linked from the previous release when the lockfile has not changed.
ship_release() {
  local host="$1" release_id="$2" previous_release_id="$3" repository="$4"
  local release_dir="$REMOTE_ROOT/releases/$release_id"
  if ssh "$host" "test -e $release_dir"; then
    echo "$release_dir already exists on $host; a release is never shipped over." >&2
    exit 1
  fi
  ssh "$host" "mkdir -p $release_dir"
  rsync -a "$repository/dist/apps/server/" "$host:$release_dir/server/"
  rsync -a "$repository/dist/apps/web/browser/" "$host:$release_dir/web/"
  ssh "$host" bash -s -- "$release_dir" "$release_id" "$REMOTE_ROOT/releases/$previous_release_id" <<'REMOTE'
set -euo pipefail
release_dir="$1" release_id="$2" previous_release_dir="$3"
echo "$release_id" >"$release_dir/release-id"
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
  ssh "$host" bash -s -- "$release_id" "$HEALTH_URL" "$HEALTH_TIMEOUT_SECONDS" <<'REMOTE'
release_id="$1" health_url="$2" timeout_seconds="$3"
deadline=$((SECONDS + timeout_seconds))
# The release install-deploy-privileges.sh made from dist/ predates releaseId, so it is known only by its database.
reports_release() {
  case "$release_id" in
    *-before-releases) ! grep -q '"releaseId":"' <<<"$1" ;;
    *) grep -q "\"releaseId\":\"$release_id\"" <<<"$1" ;;
  esac
}
report=""
while [ "$SECONDS" -lt "$deadline" ]; do
  report="$(curl -fsS --max-time 5 "$health_url" 2>/dev/null || true)"
  if grep -q '"db":true' <<<"$report" && reports_release "$report"; then
    echo "$release_id is up, and its database answers."
    exit 0
  fi
  sleep 2
done
echo "$release_id was not healthy within ${timeout_seconds}s. Last report: ${report:-none}" >&2
exit 1
REMOTE
}

read_newest_backup() {
  ssh "$1" "journalctl -u tempestas-backup.service -n 50 -o cat" | sed -n 's/^Backup written: \([^ ]*\).*/\1/p' | tail -n 1
}

# Kept in the release, because a later backup in the journal can already hold this release's schema.
record_backup_before_migrations() {
  local host="$1" release_id="$2"
  local backup
  backup="$(read_newest_backup "$host")"
  ssh "$host" "printf '%s\n' $(printf '%q' "$backup") >$REMOTE_ROOT/releases/$release_id/$BACKUP_RECORD"
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
keep_failing_release_running() {
  local host="$1" failing_release_id="$2" target_release_id="$3"
  echo "The revert did not run, so the schema is still $failing_release_id's. Restarting $failing_release_id, the code that matches it." >&2
  point_link_at_release "$host" migrator "$failing_release_id" || true
  restart_server "$host" || true
  wait_until_healthy "$host" "$failing_release_id" || true
  print_restore_instructions "$host" "$failing_release_id" "$target_release_id"
}

# Reverts with the failing release's code; every step is checked, as a caller's `if` turns `set -e` off in here.
roll_back_release() {
  local host="$1" failing_release_id="$2" target_release_id="$3"
  say "Rolling back from $failing_release_id to $target_release_id"
  if ! stop_server "$host"; then
    echo "Could not stop the server, so nothing was reverted and $failing_release_id still runs." >&2
    return 1
  fi
  if ! point_link_at_release "$host" migrator "$failing_release_id" ||
    ! run_oneshot "$host" tempestas-migrate@revert-applied.service; then
    keep_failing_release_running "$host" "$failing_release_id" "$target_release_id"
    return 1
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

# The newest few healthy releases, and whatever `current` or `migrator` point at.
prune_releases() {
  local host="$1"
  ssh "$host" bash -s -- "$REMOTE_ROOT" "$KEPT_RELEASES" "$HEALTHY_MARKER" <<'REMOTE'
set -euo pipefail
root="$1" kept_releases="$2" healthy_marker="$3"
cd "$root/releases"
newest_healthy="$(ls -1d -- */"$healthy_marker" 2>/dev/null | cut -d/ -f1 | sort | tail -n "$kept_releases" | tr '\n' ' ')"
kept=" $(basename "$(readlink "$root/current")") $(basename "$(readlink "$root/migrator")") $newest_healthy "
for release_id in *; do
  case "$kept" in
    *" $release_id "*) ;;
    *) rm -rf -- "$release_id" ;;
  esac
done
REMOTE
}
