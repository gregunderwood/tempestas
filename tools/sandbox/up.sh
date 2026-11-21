#!/usr/bin/env bash
# Bring up the sandbox with production's topology; why it is built this way is in README.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RUN="${TEMPESTAS_SANDBOX_RUN:-$HERE/run}"
SPEED="${SPEED:-60}"          # sim minutes per real minute
CO2="${CO2:-700}"
TEMP="${TEMP:-18}"
WITH_SERVERS="${WITH_SERVERS:-1}"
SIM_PORT=7100

is_with_servers() { [[ "$WITH_SERVERS" == "1" ]]; }
cleanup_note() { echo "  (stop everything with $HERE/down.sh)"; }
record_pid() { echo "$1 $2" >> "$RUN/pids"; }

# wait_until <attempts> <seconds between> <command...>
wait_until() {
  local attempts=$1 pause=$2
  shift 2
  for _ in $(seq 1 "$attempts"); do
    "$@" >/dev/null 2>&1 && return 0
    sleep "$pause"
  done
  return 0
}

mkdir -p "$RUN"
: > "$RUN/pids"
# A lock left by a killed agent blocks the next run, and fails quietly enough to look like something else.
rm -f "$RUN"/*.lock

PW="$RUN/passwd"
rm -f "$PW"
mosquitto_passwd -c -b "$PW" tempestas-server   sandbox >/dev/null 2>&1
mosquitto_passwd    -b "$PW" elantris           sandbox >/dev/null 2>&1
mosquitto_passwd    -b "$PW" greenhouse         sandbox >/dev/null 2>&1
mosquitto_passwd    -b "$PW" tempestas-observer sandbox >/dev/null 2>&1
chmod 600 "$PW"

ACL="$ROOT/apps/broker/mosquitto/tempestas.acl"
sed -e "s|PWFILE|$PW|" -e "s|ACLFILE|$ACL|" \
  "$HERE/conf/mosquitto.conf" > "$RUN/mosquitto.conf"

echo "==> mosquitto"
mosquitto -c "$RUN/mosquitto.conf" >"$RUN/mosquitto.log" 2>&1 &
record_pid mosquitto $!

echo "==> greenhouse simulator (speed ${SPEED}x)"
( cd "$ROOT/apps/sim" && uv run tempestas-sim \
    --port "$SIM_PORT" --speed "$SPEED" --co2 "$CO2" --temp "$TEMP" \
) >"$RUN/sim.log" 2>&1 &
SIM_PID=$!
record_pid sim "$SIM_PID"

wait_until 40 0.25 curl -sf "localhost:$SIM_PORT/health"
# Health alone does not prove it is our sim answering: an orphan may hold the port.
if ! kill -0 "$SIM_PID" 2>/dev/null; then
  echo "the simulator exited immediately - most likely port $SIM_PORT is still held"
  echo "by an orphan from a previous run. Check: lsof -ti tcp:$SIM_PORT"
  echo "See $RUN/sim.log"
  exit 1
fi
curl -sf "localhost:$SIM_PORT/health" >/dev/null || { echo "sim did not start; see $RUN/sim.log"; exit 1; }

if is_with_servers; then
  for pair in "elantris 5442" "greenhouse 5443"; do
    set -- $pair; NODE=$1; PGPORT=$2
    NAME="tempestas-sandbox-$NODE"
    if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      echo "==> postgres $NODE (:$PGPORT)"
      # Same major as elantris, and published for linux/arm/v7 so the greenhouse Pi can match it.
      docker run -d --rm --name "$NAME" \
        -e POSTGRES_PASSWORD=sandbox -e POSTGRES_USER=tempestas -e POSTGRES_DB=tempestas \
        -p "$PGPORT:5432" postgres:17 >/dev/null
    fi
  done

  echo "==> waiting for postgres"
  for NODE in elantris greenhouse; do
    wait_until 60 0.5 docker exec "tempestas-sandbox-$NODE" pg_isready -U tempestas
  done

  echo "==> building server + web once, then running the pair twice"
  ( cd "$ROOT" && npx nx build server && npx nx build web ) >"$RUN/build.log" 2>&1 || {
    echo "build failed; see $RUN/build.log"; exit 1; }

  # deploy.sh's layout, with web/browser flattened into web/, so the UI resolves as in production.
  APP="$RUN/app"
  rm -rf "$APP"; mkdir -p "$APP/server" "$APP/web"
  cp -R "$ROOT/dist/apps/server/." "$APP/server/"
  cp -R "$ROOT/dist/apps/web/browser/." "$APP/web/"
  ( cd "$APP/server" && npm ci --omit=dev --no-audit --no-fund ) >>"$RUN/build.log" 2>&1 || {
    echo "npm ci failed; see $RUN/build.log"; exit 1; }

  for pair in "elantris 5442 7010 leader" "greenhouse 5443 7011 follower"; do
    set -- $pair; NODE=$1; PGPORT=$2; HTTP=$3; ROLE=$4
    echo "==> server $NODE ($ROLE, :$HTTP)"
    SERVER_ENV=(
      NODE_ENV=production PORT="$HTTP"
      DATABASE_HOST=127.0.0.1 DATABASE_PORT="$PGPORT"
      DATABASE_USER=tempestas DATABASE_PASSWORD=sandbox DATABASE_NAME=tempestas
      HARDWARE_DRIVER=mqtt CONTROLLER_ROLE="$ROLE"
      MQTT_URL=mqtt://127.0.0.1:1883
      MQTT_USERNAME=tempestas-server MQTT_PASSWORD=sandbox
      TEMPESTAS_TZ=America/Vancouver
    )
    env "${SERVER_ENV[@]}" node "$APP/server/main.js" migrate:run \
        >"$RUN/migrate-$NODE.log" 2>&1 || {
          echo "migrations failed for $NODE; see $RUN/migrate-$NODE.log"; exit 1; }

    env "${SERVER_ENV[@]}" node "$APP/server/main.js" >"$RUN/server-$NODE.log" 2>&1 &
    record_pid "server-$NODE" $!
  done

  # Agents start last: `hello` is not retained, so a server subscribing late never sees them.
  echo "==> waiting for the servers to subscribe"
  for HTTP in 7010 7011; do
    wait_until 60 0.5 curl -sf "http://127.0.0.1:$HTTP/api/nodes"
  done
  # The API answering means Nest is up; the MQTT subscribe completes just after.
  sleep 1
fi

for NODE in elantris greenhouse; do
  echo "==> agent $NODE"
  ( cd "$ROOT/apps/agent-linux" && \
    MQTT_USERNAME="$NODE" MQTT_PASSWORD=sandbox \
    uv run tempestas-agent --config "$HERE/conf/agent-$NODE.toml" \
      --lock-file "$RUN/agent-$NODE.lock" \
  ) >"$RUN/agent-$NODE.log" 2>&1 &
  record_pid "agent-$NODE" $!
done

sleep 3
echo
echo "sandbox up:"
echo "  world     http://127.0.0.1:$SIM_PORT/world"
echo "  broker    mqtt://127.0.0.1:1883  (pw 'sandbox' for every identity)"
if is_with_servers; then
  echo "  leader    http://127.0.0.1:7010  (elantris,   postgres :5442)"
  echo "  follower  http://127.0.0.1:7011  (greenhouse, postgres :5443)"
fi
echo "  logs      $RUN/"
cleanup_note
