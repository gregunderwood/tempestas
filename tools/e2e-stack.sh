#!/usr/bin/env bash
# tools/e2e-stack.sh [cypress run options...]
# Runs the Cypress specs in apps/web-e2e/src/stack against a throwaway server with the fake driver.
# When and how to use it: docs/Testing.md.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SERVER_PORT="${E2E_STACK_SERVER_PORT:-7030}"
readonly WEB_PORT="${E2E_STACK_WEB_PORT:-4230}"
readonly CYPRESS_PROJECT="apps/web-e2e"
readonly CYPRESS_CONFIG="cypress.stack.config.ts"
readonly OFFERED_AGENT_APP="agent-linux"
# The simulated Pi runs the first, so the page offers the second, then a roll back to the first.
readonly OFFERED_AGENT_VERSIONS=(1.1.0 1.1.1)

source "$REPO_ROOT/tools/lib/console.sh"
source "$REPO_ROOT/tools/lib/fake-stack.sh"

readonly TOOL_NAME="e2e-stack"
readonly PORT_VARIABLES="E2E_STACK_SERVER_PORT and E2E_STACK_WEB_PORT"

WORK_DIR=""
CHECKOUT="$REPO_ROOT"
DATABASE_NAME="tempestas_e2e_stack"

main() {
  cd "$REPO_ROOT"
  require_free_port "$SERVER_PORT"
  require_free_port "$WEB_PORT"
  require_database_absent

  WORK_DIR="$(mktemp -d -t e2e-stack.XXXXXX)"
  trap tear_down EXIT

  offer_agent_releases
  create_database
  build_and_migrate_server stack
  copy_zones_from_dev_database
  start_server stack
  admit_simulated_nodes
  start_web stack
  run_stack_specs "$@"
}

require_database_absent() {
  if run_sql "$DEV_DATABASE" "select 1 from pg_database where datname = '$DATABASE_NAME'" | grep -q 1; then
    fail "database $DATABASE_NAME already exists, probably left by an interrupted run. Drop it with: docker exec $DATABASE_CONTAINER dropdb -U $DATABASE_USER --force $DATABASE_NAME"
  fi
}

offer_agent_releases() {
  say "Writing fake $OFFERED_AGENT_APP releases ${OFFERED_AGENT_VERSIONS[*]}"
  SERVER_DIRECTORY="$WORK_DIR/server"
  node "$REPO_ROOT/tools/lib/write-fake-agent-releases.mjs" \
    "$SERVER_DIRECTORY/agent-releases" "$OFFERED_AGENT_APP" "${OFFERED_AGENT_VERSIONS[@]}"
  EXTRA_SERVER_ENVIRONMENT=("AGENT_RELEASES_URL=http://127.0.0.1:$SERVER_PORT")
}

# VS Code exports ELECTRON_RUN_AS_NODE, and Cypress then refuses to start.
# The base URL goes by environment: Cypress keeps only the last --config, and the caller may pass one.
run_stack_specs() {
  say "Running the stack specs"
  env -u ELECTRON_RUN_AS_NODE CYPRESS_baseUrl="http://localhost:$WEB_PORT" npx cypress run \
    --project "$CYPRESS_PROJECT" \
    --config-file "$CYPRESS_CONFIG" \
    "$@"
}

tear_down() {
  local exit_status=$?
  say "Tearing down"
  stop_process_group "$WEB_PROCESS"
  stop_process_group "$SERVER_PROCESS"
  docker exec "$DATABASE_CONTAINER" dropdb -U "$DATABASE_USER" --if-exists --force "$DATABASE_NAME" || true
  rm -rf "$WORK_DIR"
  warn_if_still_listening "$SERVER_PORT"
  warn_if_still_listening "$WEB_PORT"
  exit "$exit_status"
}

main "$@"
