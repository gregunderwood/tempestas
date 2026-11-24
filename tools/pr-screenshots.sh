#!/usr/bin/env bash
# tools/pr-screenshots.sh [--after-only] <pr> <page>...
# Posts before-and-after desktop and phone screenshots of a PR's pages, each taken on a throwaway dev stack with the fake driver.
# When and how to use it: docs/Testing.md.

set -euo pipefail

readonly USAGE="Usage: tools/pr-screenshots.sh [--after-only] <pr> <page>...   e.g. tools/pr-screenshots.sh 138 dashboard nodes/sim-pi"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SERVER_PORT="${PR_SCREENSHOTS_SERVER_PORT:-7020}"
readonly WEB_PORT="${PR_SCREENSHOTS_WEB_PORT:-4220}"
readonly DATABASE_CONTAINER="tempestas-db"
readonly DATABASE_PORT=5433
readonly DATABASE_USER="tempestas"
readonly DEV_DATABASE="tempestas"
readonly SCREENSHOTS_BRANCH="pr-screenshots"
readonly COMMENT_MARKER="<!-- pr-screenshots -->"
readonly DESKTOP_WINDOW="1280,860"
readonly PHONE_WINDOW="390,844"
readonly SIDE_BY_SIDE_DESKTOP_WIDTH=400
readonly SIDE_BY_SIDE_PHONE_WIDTH=180
readonly AFTER_ONLY_DESKTOP_WIDTH=560
readonly AFTER_ONLY_PHONE_WIDTH=200
readonly PAGE_SETTLE_MILLISECONDS=8000
readonly STARTUP_ATTEMPTS=240
readonly FAKE_NODE_COUNT=2
readonly PUSH_ATTEMPTS=3

source "$REPO_ROOT/tools/lib/console.sh"

PULL_REQUEST=""
PAGES=()
IS_AFTER_ONLY=false
WORK_DIR=""
HEAD_SHA=""
BASE_SHA=""
BASE_CHECKOUT=""
SCREENSHOTS_CHECKOUT=""
CHECKOUT=""
DATABASE_NAME=""
SERVER_PROCESS=""
WEB_PROCESS=""
CREATED_DATABASES=()

main() {
  parse_arguments "$@"
  cd "$REPO_ROOT"
  require_pull_request_checked_out
  require_free_port "$SERVER_PORT"
  require_free_port "$WEB_PORT"
  require_databases_absent

  WORK_DIR="$(mktemp -d -t pr-screenshots.XXXXXX)"
  trap tear_down EXIT

  if ! $IS_AFTER_ONLY; then
    check_out_base
    shoot_checkout "$BASE_CHECKOUT" before
  fi
  shoot_checkout "$REPO_ROOT" after
  publish_screenshots
  post_comment
}

parse_arguments() {
  if [[ "${1:-}" == "--after-only" ]]; then
    IS_AFTER_ONLY=true
    shift
  fi
  if [[ $# -lt 2 || ! "$1" =~ ^[0-9]+$ ]]; then
    echo "$USAGE" >&2
    exit 2
  fi
  PULL_REQUEST="$1"
  shift
  PAGES=("$@")
}

require_pull_request_checked_out() {
  local pull_request_head
  pull_request_head="$(gh pr view "$PULL_REQUEST" --json headRefOid --jq .headRefOid)"
  HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  if [[ "$HEAD_SHA" != "$pull_request_head" ]]; then
    fail "this checkout is at ${HEAD_SHA:0:7}, but PR #$PULL_REQUEST is at ${pull_request_head:0:7}. Check out and push the PR's branch first."
  fi
  if ! git -C "$REPO_ROOT" diff --quiet HEAD; then
    fail "this checkout has uncommitted changes, so the screenshots would not show commit ${HEAD_SHA:0:7}."
  fi
}

require_free_port() {
  local port=$1
  if is_port_listening "$port"; then
    fail "something is already listening on port $port. Stop it, or choose other ports with PR_SCREENSHOTS_SERVER_PORT and PR_SCREENSHOTS_WEB_PORT."
  fi
}

is_port_listening() {
  [[ -n "$(ss -ltnH "sport = :$1")" ]]
}

require_databases_absent() {
  local label
  for label in before after; do
    local database
    database="$(database_name_for "$label")"
    if run_sql "$DEV_DATABASE" "select 1 from pg_database where datname = '$database'" | grep -q 1; then
      fail "database $database already exists, probably left by an interrupted run. Drop it with: docker exec $DATABASE_CONTAINER dropdb -U $DATABASE_USER --force $database"
    fi
  done
}

database_name_for() {
  echo "tempestas_pr_${PULL_REQUEST}_$1"
}

# The merge-base, not main's tip, so "before" differs from "after" only by this PR.
# Beside the repo, not in /tmp: node_modules is hard-linked, which needs the same filesystem.
check_out_base() {
  local base_branch
  base_branch="$(gh pr view "$PULL_REQUEST" --json baseRefName --jq .baseRefName)"
  git -C "$REPO_ROOT" fetch --quiet origin "$base_branch"
  BASE_SHA="$(git -C "$REPO_ROOT" merge-base HEAD "origin/$base_branch")"
  say "Checking out the base, ${BASE_SHA:0:7}, for the before screenshots"
  BASE_CHECKOUT="$(mktemp -d "$(dirname "$REPO_ROOT")/.pr-screenshots-base.XXXXXX")"
  git -C "$REPO_ROOT" worktree add --quiet --detach "$BASE_CHECKOUT" "$BASE_SHA"
  cp -al "$REPO_ROOT/node_modules" "$BASE_CHECKOUT/node_modules"
}

shoot_checkout() {
  CHECKOUT=$1
  local label=$2
  say "Screenshots of $label, from $(git -C "$CHECKOUT" rev-parse --short HEAD)"
  DATABASE_NAME="$(database_name_for "$label")"
  create_database
  build_and_migrate_server "$label"
  copy_zones_from_dev_database
  start_server "$label"
  admit_simulated_nodes
  wait_for_readings_and_rules_cycle
  start_web "$label"
  take_screenshots "$label"
  stop_stack
}

create_database() {
  docker exec "$DATABASE_CONTAINER" createdb -U "$DATABASE_USER" "$DATABASE_NAME"
  CREATED_DATABASES+=("$DATABASE_NAME")
}

build_and_migrate_server() {
  local label=$1
  say "Building the server and running its migrations"
  run_nx build server >"$WORK_DIR/$label-build.log" 2>&1 || fail_with_log "the server build failed" "$label-build.log"
  local environment
  mapfile -t environment < <(server_environment)
  env "${environment[@]}" node "$CHECKOUT/dist/apps/server/main.js" migrate:run \
    >"$WORK_DIR/$label-migrate.log" 2>&1 || fail_with_log "the migrations failed" "$label-migrate.log"
}

copy_zones_from_dev_database() {
  say "Copying zones from the dev database"
  docker exec "$DATABASE_CONTAINER" pg_dump -U "$DATABASE_USER" --data-only --table=zones "$DEV_DATABASE" |
    docker exec -i "$DATABASE_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U "$DATABASE_USER" -d "$DATABASE_NAME" >/dev/null ||
    fail "copying zones failed; the dev database's zones table probably differs from this checkout's schema."
  if [[ -z "$(list_zone_ids)" ]]; then
    fail "the dev database has no zones to copy. Create one in the dev stack first."
  fi
}

start_server() {
  local label=$1
  say "Starting the server on port $SERVER_PORT with the fake hardware driver"
  local environment
  mapfile -t environment < <(server_environment)
  setsid env "${environment[@]}" node "$CHECKOUT/dist/apps/server/main.js" >"$WORK_DIR/$label-server.log" 2>&1 &
  SERVER_PROCESS=$!
  wait_until_answering "http://127.0.0.1:$SERVER_PORT/api/nodes" "$SERVER_PROCESS" "$label-server.log"
}

# Explicit variables win over the checkout's own apps/server/.env, so a real driver there is never used.
server_environment() {
  echo NODE_ENV=development
  echo PORT="$SERVER_PORT"
  echo HARDWARE_DRIVER=fake
  echo TEMPESTAS_TZ=America/Vancouver
  echo DATABASE_HOST=127.0.0.1
  echo DATABASE_PORT="$DATABASE_PORT"
  echo DATABASE_USER="$DATABASE_USER"
  echo DATABASE_PASSWORD=tempestas
  echo DATABASE_NAME="$DATABASE_NAME"
}

fetch_api() {
  curl -sf "http://127.0.0.1:$SERVER_PORT/api/$1"
}

admit_simulated_nodes() {
  say "Admitting the simulated nodes"
  wait_until have_all_simulated_nodes_said_hello || fail "the simulated nodes never said hello"
  local zone_ids node_ids
  mapfile -t zone_ids < <(list_zone_ids)
  mapfile -t node_ids < <(list_node_ids)
  local index
  for index in "${!node_ids[@]}"; do
    local zone_id="${zone_ids[$((index % ${#zone_ids[@]}))]}"
    curl -sf -X POST "http://127.0.0.1:$SERVER_PORT/api/nodes/${node_ids[$index]}/admit" \
      -H 'Content-Type: application/json' -d "{\"zoneId\":\"$zone_id\"}" >/dev/null ||
      fail "could not admit node ${node_ids[$index]}"
  done
}

have_all_simulated_nodes_said_hello() {
  [[ "$(list_node_ids | wc -l)" -ge "$FAKE_NODE_COUNT" ]]
}

wait_for_readings_and_rules_cycle() {
  say "Waiting for the first readings and rules cycle, so pages show more than empty states"
  wait_until has_readings_and_rules_cycle || fail "no readings or rules cycle arrived"
}

has_readings_and_rules_cycle() {
  [[ "$(fetch_api readings/latest)" == '[{'* ]] && [[ "$(fetch_api rules/latest-cycle)" == '{"cycle":{'* ]]
}

wait_until() {
  local condition=$1
  local attempt
  for attempt in $(seq 1 "$STARTUP_ATTEMPTS"); do
    "$condition" && return 0
    sleep 0.5
  done
  return 1
}

list_zone_ids() {
  run_sql "$DATABASE_NAME" "select id from zones order by slug"
}

list_node_ids() {
  fetch_api nodes |
    node -e 'let input = ""; process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => {
      for (const node of JSON.parse(input)) console.log(node.id);
    });'
}

start_web() {
  local label=$1
  say "Starting the web app on port $WEB_PORT"
  write_proxy_config
  setsid env NX_WORKSPACE_ROOT_PATH="$CHECKOUT" NX_DAEMON=false \
    bash -c 'cd "$1" && shift && exec npx nx serve web "$@"' _ "$CHECKOUT" \
    --port "$WEB_PORT" --proxy-config "$WORK_DIR/proxy.json" \
    >"$WORK_DIR/$label-web.log" 2>&1 &
  WEB_PROCESS=$!
  wait_until_answering "http://localhost:$WEB_PORT/" "$WEB_PROCESS" "$label-web.log"
}

write_proxy_config() {
  cat >"$WORK_DIR/proxy.json" <<JSON
{
  "/api": { "target": "http://localhost:$SERVER_PORT", "secure": false },
  "/socket.io": { "target": "http://localhost:$SERVER_PORT", "secure": false, "ws": true }
}
JSON
}

wait_until_answering() {
  local url=$1 process=$2 log_name=$3
  local attempt
  for attempt in $(seq 1 "$STARTUP_ATTEMPTS"); do
    kill -0 "$process" 2>/dev/null || fail_with_log "it exited while starting" "$log_name"
    curl -sf -o /dev/null "$url" && return 0
    sleep 1
  done
  fail_with_log "$url never answered" "$log_name"
}

take_screenshots() {
  local label=$1
  say "Taking screenshots"
  mkdir -p "$WORK_DIR/shots"
  local page
  for page in "${PAGES[@]}"; do
    take_screenshot "$page" desktop "$DESKTOP_WINDOW" "$label"
    take_screenshot "$page" phone "$PHONE_WINDOW" "$label"
  done
}

take_screenshot() {
  local page=$1 form_factor=$2 window_size=$3 label=$4
  local file="$WORK_DIR/shots/$(image_name "$page" "$form_factor" "$label")"
  google-chrome --headless=new --hide-scrollbars --no-first-run --disable-gpu \
    --user-data-dir="$WORK_DIR/chrome-profile-$label" \
    --virtual-time-budget="$PAGE_SETTLE_MILLISECONDS" \
    --window-size="$window_size" \
    --screenshot="$file" \
    "http://localhost:$WEB_PORT/${page#/}" >>"$WORK_DIR/chrome.log" 2>&1
  [[ -s "$file" ]] || fail_with_log "no screenshot of $page at $form_factor width" chrome.log
  echo "  $page, $form_factor, $label"
}

image_name() {
  local page="${1#/}" form_factor=$2 label=$3
  echo "${page//\//-}-$form_factor-$label.png"
}

stop_stack() {
  stop_process_group "$WEB_PROCESS"
  stop_process_group "$SERVER_PROCESS"
  WEB_PROCESS=""
  SERVER_PROCESS=""
  wait_until are_ports_free || fail "ports $SERVER_PORT and $WEB_PORT are still in use after stopping the stack"
}

are_ports_free() {
  ! is_port_listening "$SERVER_PORT" && ! is_port_listening "$WEB_PORT"
}

# Only ever adds a commit: every posted comment pins its images to a commit on this branch.
publish_screenshots() {
  say "Pushing the screenshots to $SCREENSHOTS_BRANCH"
  git -C "$REPO_ROOT" fetch --quiet origin "$SCREENSHOTS_BRANCH"
  SCREENSHOTS_CHECKOUT="$WORK_DIR/$SCREENSHOTS_BRANCH"
  git -C "$REPO_ROOT" worktree add --quiet --detach "$SCREENSHOTS_CHECKOUT" "origin/$SCREENSHOTS_BRANCH"
  mkdir -p "$SCREENSHOTS_CHECKOUT/$PULL_REQUEST"
  cp "$WORK_DIR"/shots/*.png "$SCREENSHOTS_CHECKOUT/$PULL_REQUEST/"
  git -C "$SCREENSHOTS_CHECKOUT" add "$PULL_REQUEST"
  if git -C "$SCREENSHOTS_CHECKOUT" diff --cached --quiet; then
    return 0
  fi
  git -C "$SCREENSHOTS_CHECKOUT" commit --quiet \
    -m "chore: screenshots for #$PULL_REQUEST" \
    -m "Taken at ${HEAD_SHA:0:7} by tools/pr-screenshots.sh."
  push_screenshots_commit
}

# Another run may push first; replaying this one commit on top still only appends.
push_screenshots_commit() {
  local attempt
  for attempt in $(seq 1 "$PUSH_ATTEMPTS"); do
    git -C "$SCREENSHOTS_CHECKOUT" push --quiet origin "HEAD:$SCREENSHOTS_BRANCH" && return 0
    git -C "$SCREENSHOTS_CHECKOUT" fetch --quiet origin "$SCREENSHOTS_BRANCH"
    git -C "$SCREENSHOTS_CHECKOUT" rebase --quiet "origin/$SCREENSHOTS_BRANCH"
  done
  fail "could not push to $SCREENSHOTS_BRANCH after $PUSH_ATTEMPTS attempts"
}

post_comment() {
  say "Posting the screenshots on PR #$PULL_REQUEST"
  write_comment_body >"$WORK_DIR/comment.md"
  local existing_comment
  existing_comment="$(find_screenshots_comment)"
  if [[ -n "$existing_comment" ]]; then
    gh api --silent -X PATCH "repos/{owner}/{repo}/issues/comments/$existing_comment" -F body=@"$WORK_DIR/comment.md"
  else
    gh api --silent -X POST "repos/{owner}/{repo}/issues/$PULL_REQUEST/comments" -F body=@"$WORK_DIR/comment.md"
  fi
  echo "  $(gh pr view "$PULL_REQUEST" --json url --jq .url)"
}

find_screenshots_comment() {
  gh api --paginate "repos/{owner}/{repo}/issues/$PULL_REQUEST/comments" \
    --jq ".[] | select(.body | startswith(\"$COMMENT_MARKER\")) | .id" | head -n 1
}

write_comment_body() {
  local image_base
  image_base="https://github.com/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/blob/$(git -C "$SCREENSHOTS_CHECKOUT" rev-parse HEAD)/$PULL_REQUEST"
  echo "$COMMENT_MARKER"
  echo "## Screenshots"
  echo
  describe_what_was_taken
  local page
  for page in "${PAGES[@]}"; do
    echo
    echo "### \`/${page#/}\`"
    echo
    if $IS_AFTER_ONLY; then
      write_after_only_table "$image_base" "$page"
    else
      write_before_and_after_table "$image_base" "$page"
    fi
  done
}

describe_what_was_taken() {
  local stack="on a local dev stack (fake hardware driver, simulated nodes), with headless Chrome. Stored on the \`$SCREENSHOTS_BRANCH\` branch."
  if $IS_AFTER_ONLY; then
    echo "Taken at \`${HEAD_SHA:0:7}\` by \`tools/pr-screenshots.sh\` $stack"
  else
    echo "Before is the base, \`${BASE_SHA:0:7}\`; after is this PR, \`${HEAD_SHA:0:7}\`. Taken by \`tools/pr-screenshots.sh\` $stack"
  fi
}

write_before_and_after_table() {
  local image_base=$1 page=$2
  echo "| | Before | After |"
  echo "| --- | --- | --- |"
  echo "| Desktop, ${DESKTOP_WINDOW%%,*} px | $(image_tag "$image_base" "$page" desktop before "$SIDE_BY_SIDE_DESKTOP_WIDTH") | $(image_tag "$image_base" "$page" desktop after "$SIDE_BY_SIDE_DESKTOP_WIDTH") |"
  echo "| Phone, ${PHONE_WINDOW%%,*} px | $(image_tag "$image_base" "$page" phone before "$SIDE_BY_SIDE_PHONE_WIDTH") | $(image_tag "$image_base" "$page" phone after "$SIDE_BY_SIDE_PHONE_WIDTH") |"
}

write_after_only_table() {
  local image_base=$1 page=$2
  echo "| Desktop, ${DESKTOP_WINDOW%%,*} px | Phone, ${PHONE_WINDOW%%,*} px |"
  echo "| --- | --- |"
  echo "| $(image_tag "$image_base" "$page" desktop after "$AFTER_ONLY_DESKTOP_WIDTH") | $(image_tag "$image_base" "$page" phone after "$AFTER_ONLY_PHONE_WIDTH") |"
}

image_tag() {
  local image_base=$1 page=$2 form_factor=$3 label=$4 width=$5
  echo "<img src=\"$image_base/$(image_name "$page" "$form_factor" "$label")?raw=true\" width=\"$width\">"
}

tear_down() {
  local exit_status=$?
  say "Tearing down"
  stop_process_group "$WEB_PROCESS"
  stop_process_group "$SERVER_PROCESS"
  local database
  for database in "${CREATED_DATABASES[@]}"; do
    docker exec "$DATABASE_CONTAINER" dropdb -U "$DATABASE_USER" --if-exists --force "$database" || true
  done
  remove_worktree "$SCREENSHOTS_CHECKOUT"
  remove_worktree "$BASE_CHECKOUT"
  rm -rf "$WORK_DIR"
  warn_if_still_listening "$SERVER_PORT"
  warn_if_still_listening "$WEB_PORT"
  exit "$exit_status"
}

remove_worktree() {
  local worktree=$1
  [[ -n "$worktree" ]] || return 0
  git -C "$REPO_ROOT" worktree remove --force "$worktree" || true
  rm -rf "$worktree"
}

warn_if_still_listening() {
  local port=$1
  if is_port_listening "$port"; then
    echo "pr-screenshots: something still listens on port $port after tear-down; stop it by hand." >&2
  fi
}

stop_process_group() {
  local process=$1
  [[ -n "$process" ]] || return 0
  kill -TERM -- "-$process" 2>/dev/null || return 0
  local attempt
  for attempt in $(seq 1 20); do
    kill -0 -- "-$process" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -KILL -- "-$process" 2>/dev/null || true
}

run_nx() {
  (cd "$CHECKOUT" && NX_WORKSPACE_ROOT_PATH="$CHECKOUT" NX_DAEMON=false npx nx "$@")
}

run_sql() {
  local database=$1 statement=$2
  docker exec "$DATABASE_CONTAINER" psql -qtAX -U "$DATABASE_USER" -d "$database" -c "$statement"
}

fail() {
  echo "pr-screenshots: $1" >&2
  exit 1
}

fail_with_log() {
  local reason=$1 log_name=$2
  echo "pr-screenshots: $reason. The end of $log_name:" >&2
  tail -n 30 "$WORK_DIR/$log_name" >&2 || true
  exit 1
}

main "$@"
