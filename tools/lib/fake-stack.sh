# Sourced by tools/pr-screenshots.sh and tools/e2e-stack.sh: a throwaway server, fake driver and web app.
# The caller sets TOOL_NAME, PORT_VARIABLES, SERVER_PORT, WEB_PORT, DATABASE_NAME, CHECKOUT and WORK_DIR.

readonly DATABASE_CONTAINER="tempestas-db"
readonly DATABASE_PORT=5433
readonly DATABASE_USER="tempestas"
readonly DEV_DATABASE="tempestas"
readonly STARTUP_ATTEMPTS=240
readonly FAKE_NODE_COUNT=2

CREATED_DATABASES=()
SERVER_PROCESS=""
WEB_PROCESS=""
SERVER_DIRECTORY=""
EXTRA_SERVER_ENVIRONMENT=()

require_free_port() {
  local port=$1
  if is_port_listening "$port"; then
    fail "something is already listening on port $port. Stop it, or choose other ports with $PORT_VARIABLES."
  fi
}

is_port_listening() {
  [[ -n "$(ss -ltnH "sport = :$1")" ]]
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
  # Run where the server finds its agent-releases folder, when the caller gives one.
  (cd "${SERVER_DIRECTORY:-$PWD}" && exec setsid env "${environment[@]}" node "$CHECKOUT/dist/apps/server/main.js") \
    >"$WORK_DIR/$label-server.log" 2>&1 &
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
  local setting
  for setting in "${EXTRA_SERVER_ENVIRONMENT[@]}"; do
    echo "$setting"
  done
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

# Devices point at node ids, which differ per database, so they are created through the API, not copied.
# Each zone's enabled roles go to its node's pins in order, so the rules switch them and reports have runs.
create_devices_on_simulated_pins() {
  say "Creating a device on each simulated relay pin"
  env FAKE_STACK_API_PORT="$SERVER_PORT" node -e '
    const api = `http://127.0.0.1:${process.env.FAKE_STACK_API_PORT}/api`;
    const fetchJson = async (path) => (await fetch(`${api}/${path}`)).json();
    (async () => {
      const zones = await fetchJson("zones");
      const rolesByZone = new Map(zones.map((zone) => [zone.id, zone.rulesConfig?.enabledRoles ?? []]));
      for (const node of await fetchJson("nodes")) {
        const pins = node.capabilities?.gpio?.pins ?? [];
        const roles = rolesByZone.get(node.zoneId) ?? [];
        for (const [index, pin] of pins.entries()) {
          const response = await fetch(`${api}/devices`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              nodeId: node.slug,
              zoneId: node.zoneId,
              name: roles[index] ? roles[index].replaceAll("_", " ") : `${node.slug} pin ${pin}`,
              gpio: pin,
              onLevel: 1,
              onDelayDuration: 0,
              rulesEnabled: true,
              role: roles[index] ?? null,
            }),
          });
          if (!response.ok) throw new Error(`device on ${node.slug} pin ${pin}: ${response.status} ${await response.text()}`);
        }
      }
    })().catch((error) => { console.error(error.message); process.exit(1); });
  ' || fail "could not create the devices"
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

warn_if_still_listening() {
  local port=$1
  if is_port_listening "$port"; then
    echo "$TOOL_NAME: something still listens on port $port after tear-down; stop it by hand." >&2
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
  echo "$TOOL_NAME: $1" >&2
  exit 1
}

fail_with_log() {
  local reason=$1 log_name=$2
  echo "$TOOL_NAME: $reason. The end of $log_name:" >&2
  tail -n 30 "$WORK_DIR/$log_name" >&2 || true
  exit 1
}
