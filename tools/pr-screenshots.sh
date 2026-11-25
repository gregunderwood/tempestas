#!/usr/bin/env bash
# tools/pr-screenshots.sh [--after-only] [--history] <pr> <page>...
# Posts before-and-after desktop and phone screenshots of a PR's pages, each taken on a throwaway dev stack with the fake driver.
# When and how to use it: docs/Testing.md.

set -euo pipefail

readonly USAGE="Usage: tools/pr-screenshots.sh [--after-only] [--history] <pr> <page>...   e.g. tools/pr-screenshots.sh --history 139 reports"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SERVER_PORT="${PR_SCREENSHOTS_SERVER_PORT:-7020}"
readonly WEB_PORT="${PR_SCREENSHOTS_WEB_PORT:-4220}"
readonly COMMENT_MARKER="<!-- pr-screenshots -->"
readonly DESKTOP_WINDOW="1280,860"
readonly PHONE_WINDOW="390,844"
readonly SIDE_BY_SIDE_DESKTOP_WIDTH=400
readonly SIDE_BY_SIDE_PHONE_WIDTH=180
readonly AFTER_ONLY_DESKTOP_WIDTH=560
readonly AFTER_ONLY_PHONE_WIDTH=200
readonly PAGE_SETTLE_MILLISECONDS=8000

source "$REPO_ROOT/tools/lib/console.sh"
source "$REPO_ROOT/tools/lib/failure.sh"
source "$REPO_ROOT/tools/lib/fake-stack.sh"
source "$REPO_ROOT/tools/lib/pull-request-media.sh"

readonly TOOL_NAME="pr-screenshots"
readonly PORT_VARIABLES="PR_SCREENSHOTS_SERVER_PORT and PR_SCREENSHOTS_WEB_PORT"

PULL_REQUEST=""
PAGES=()
IS_AFTER_ONLY=false
SHOULD_SEED_HISTORY=false
WORK_DIR=""
BASE_SHA=""
BASE_CHECKOUT=""
CHECKOUT=""
DATABASE_NAME=""

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
  while [[ "${1:-}" == --* ]]; do
    case "$1" in
      --after-only) IS_AFTER_ONLY=true ;;
      --history) SHOULD_SEED_HISTORY=true ;;
      *)
        echo "$USAGE" >&2
        exit 2
        ;;
    esac
    shift
  done
  if [[ $# -lt 2 || ! "$1" =~ ^[0-9]+$ ]]; then
    echo "$USAGE" >&2
    exit 2
  fi
  PULL_REQUEST="$1"
  shift
  PAGES=("$@")
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
  create_devices_on_simulated_pins
  if $SHOULD_SEED_HISTORY; then
    seed_runtime_history "$label"
  fi
  wait_for_readings_and_rules_cycle
  if $SHOULD_SEED_HISTORY; then
    seed_reading_history "$label"
  fi
  start_web "$label"
  take_screenshots "$label"
  stop_stack
}

# From this checkout on both sides, since the base may predate the script.
seed_runtime_history() {
  local label=$1
  say "Seeding $label with simulated runtime history"
  node "$REPO_ROOT/tools/seed-runtime-history.mjs" "$DATABASE_NAME" >"$WORK_DIR/$label-history.log" 2>&1 ||
    fail_with_log "seeding the runtime history failed" "$label-history.log"
}

# After the first readings: it seeds only probes that have reported, up to their first real reading.
seed_reading_history() {
  local label=$1
  say "Seeding $label with simulated temperature readings"
  node "$REPO_ROOT/tools/seed-reading-history.mjs" "$DATABASE_NAME" >"$WORK_DIR/$label-readings.log" 2>&1 ||
    fail_with_log "seeding the readings failed" "$label-readings.log"
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

publish_screenshots() {
  publish_media "chore: screenshots for #$PULL_REQUEST" "$WORK_DIR"/shots/*.png
}

post_comment() {
  say "Posting the screenshots on PR #$PULL_REQUEST"
  write_comment_body >"$WORK_DIR/comment.md"
  post_marked_comment "$COMMENT_MARKER" "$WORK_DIR/comment.md"
}

write_comment_body() {
  local image_base
  image_base="$(media_url_base blob)"
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
  local stack="on a local dev stack (fake hardware driver, simulated nodes), with headless Chrome. Stored on the \`$MEDIA_BRANCH\` branch."
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
  remove_worktree "$MEDIA_CHECKOUT"
  remove_worktree "$BASE_CHECKOUT"
  rm -rf "$WORK_DIR"
  warn_if_still_listening "$SERVER_PORT"
  warn_if_still_listening "$WEB_PORT"
  exit "$exit_status"
}

main "$@"
