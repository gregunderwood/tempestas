#!/usr/bin/env bash
# Bring up the sandbox: one shared greenhouse, one broker, two node agents.
#
# The topology mirrors what we plan to run on the real hardware - a single
# broker on elantris with greenhouse's agent pointing at it - so "it works in
# the sandbox" is a statement about production and not about a toy.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RUN="${TEMPESTAS_SANDBOX_RUN:-$HERE/run}"
SPEED="${SPEED:-60}"          # sim minutes per real minute
CO2="${CO2:-700}"
TEMP="${TEMP:-18}"

mkdir -p "$RUN"
: > "$RUN/pids"
# A lock left by a killed agent blocks the next run, and the failure is quiet
# enough to look like something else.
rm -f "$RUN"/*.lock

cleanup_note() { echo "  (stop everything with $HERE/down.sh)"; }

# ---------------------------------------------------------------- broker
PW="$RUN/passwd"
rm -f "$PW"
# The same identities production uses, so the sandbox exercises the same ACL.
mosquitto_passwd -c -b "$PW" tempestas-server   sandbox >/dev/null 2>&1
mosquitto_passwd    -b "$PW" elantris           sandbox >/dev/null 2>&1
mosquitto_passwd    -b "$PW" greenhouse         sandbox >/dev/null 2>&1
mosquitto_passwd    -b "$PW" tempestas-observer sandbox >/dev/null 2>&1
chmod 600 "$PW"

# The PRODUCTION acl file, not a copy. A sandbox running looser rules than the
# greenhouse would not have caught the silent QoS-0 denial that bit us once.
ACL="$ROOT/apps/broker/mosquitto/tempestas.acl"
sed -e "s|PWFILE|$PW|" -e "s|ACLFILE|$ACL|" \
  "$HERE/conf/mosquitto.conf" > "$RUN/mosquitto.conf"

echo "==> mosquitto"
mosquitto -c "$RUN/mosquitto.conf" >"$RUN/mosquitto.log" 2>&1 &
echo "mosquitto $!" >> "$RUN/pids"

# ---------------------------------------------------------------- world
echo "==> greenhouse simulator (speed ${SPEED}x)"
( cd "$ROOT/apps/sim" && uv run tempestas-sim \
    --port 7100 --speed "$SPEED" --co2 "$CO2" --temp "$TEMP" \
) >"$RUN/sim.log" 2>&1 &
echo "sim $!" >> "$RUN/pids"

SIM_PID=$!
for _ in $(seq 1 40); do
  curl -sf localhost:7100/health >/dev/null 2>&1 && break
  sleep 0.25
done
# Health alone is NOT proof the sim we just started is the one answering. An
# orphan from a previous run holds the port, the new process exits with
# "address already in use", and the sandbox quietly runs against a world with
# different constants and a different clock.
if ! kill -0 "$SIM_PID" 2>/dev/null; then
  echo "the simulator exited immediately - most likely port 7100 is still held"
  echo "by an orphan from a previous run. Check: lsof -ti tcp:7100"
  echo "See $RUN/sim.log"
  exit 1
fi
curl -sf localhost:7100/health >/dev/null || { echo "sim did not start; see $RUN/sim.log"; exit 1; }

# ---------------------------------------------------------------- databases
# Two SEPARATE Postgres instances, not two schemas. Per-box databases are the
# design, not an implementation detail, so the sandbox must not quietly share
# one and make takeover look easier than it is.
if [[ "${WITH_SERVERS:-1}" == "1" ]]; then
  for pair in "elantris 5442" "greenhouse 5443"; do
    set -- $pair; NODE=$1; PGPORT=$2
    NAME="tempestas-sandbox-$NODE"
    if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      echo "==> postgres $NODE (:$PGPORT)"
      # Same major as elantris runs. The official image publishes linux/arm/v7,
      # so the greenhouse Pi can run this exact version too.
      docker run -d --rm --name "$NAME" \
        -e POSTGRES_PASSWORD=sandbox -e POSTGRES_USER=tempestas -e POSTGRES_DB=tempestas \
        -p "$PGPORT:5432" postgres:17 >/dev/null
    fi
  done

  echo "==> waiting for postgres"
  for PGPORT in 5442 5443; do
    for _ in $(seq 1 60); do
      docker exec "tempestas-sandbox-$([[ $PGPORT == 5433 ]] && echo elantris || echo greenhouse)" \
        pg_isready -U tempestas >/dev/null 2>&1 && break
      sleep 0.5
    done
  done

  # ---------------------------------------------------------------- servers
  echo "==> building server + web once, then running the pair twice"
  ( cd "$ROOT" && npx nx build server && npx nx build web ) >"$RUN/build.log" 2>&1 || {
    echo "build failed; see $RUN/build.log"; exit 1; }

  # Stage the PRODUCTION layout. The server serves `../web` relative to its own
  # bundle, and tools/deploy.sh rsyncs dist/apps/web/browser/ INTO dist/apps/web/
  # - flattening `browser` away. Running straight out of dist/ would leave
  # index.html one directory deeper than the server looks, so the UI would 404
  # in the sandbox while working in production. Mirror the layout instead.
  # NOT under a dot directory. Express's res.sendFile - which the SPA fallback
  # uses with an absolute path - applies its `dotfiles: ignore` rule across the
  # WHOLE path, so a root under `.run/` makes every deep link 404 while `/`
  # still works (that goes through the static middleware with a root-relative
  # `index.html`, which has no dot segment). Cost me a bisect.
  APP="$RUN/app"
  rm -rf "$APP"; mkdir -p "$APP/server" "$APP/web"
  cp -R "$ROOT/dist/apps/server/." "$APP/server/"
  cp -R "$ROOT/dist/apps/web/browser/." "$APP/web/"
  ( cd "$APP/server" && npm ci --omit=dev --no-audit --no-fund ) >>"$RUN/build.log" 2>&1 || {
    echo "npm ci failed; see $RUN/build.log"; exit 1; }

  for pair in "elantris 5442 7010 leader" "greenhouse 5443 7011 follower"; do
    set -- $pair; NODE=$1; PGPORT=$2; HTTP=$3; ROLE=$4
    echo "==> server $NODE ($ROLE, :$HTTP)"
    env NODE_ENV=production PORT="$HTTP" \
        DATABASE_HOST=127.0.0.1 DATABASE_PORT="$PGPORT" \
        DATABASE_USER=tempestas DATABASE_PASSWORD=sandbox DATABASE_NAME=tempestas \
        HARDWARE_DRIVER=mqtt CONTROLLER_ROLE="$ROLE" \
        MQTT_URL=mqtt://127.0.0.1:1883 \
        MQTT_USERNAME=tempestas-server MQTT_PASSWORD=sandbox \
        TEMPESTAS_TZ=America/Vancouver \
        node "$APP/server/main.js" migrate:run \
        >"$RUN/migrate-$NODE.log" 2>&1 || {
          echo "migrations failed for $NODE; see $RUN/migrate-$NODE.log"; exit 1; }

    env NODE_ENV=production PORT="$HTTP" \
        DATABASE_HOST=127.0.0.1 DATABASE_PORT="$PGPORT" \
        DATABASE_USER=tempestas DATABASE_PASSWORD=sandbox DATABASE_NAME=tempestas \
        HARDWARE_DRIVER=mqtt CONTROLLER_ROLE="$ROLE" \
        MQTT_URL=mqtt://127.0.0.1:1883 \
        MQTT_USERNAME=tempestas-server MQTT_PASSWORD=sandbox \
        TEMPESTAS_TZ=America/Vancouver \
        node "$APP/server/main.js" >"$RUN/server-$NODE.log" 2>&1 &
    echo "server-$NODE $!" >> "$RUN/pids"
  done
fi

# ---------------------------------------------------------------- agents
# Started LAST, and only once the servers ANSWER. `hello` is QoS 1 and not
# retained, so an agent that announces before the server has finished
# subscribing is never seen and the node is never created. Production
# self-heals because nodes persist in its database; a sandbox with a fresh
# database would simply never discover them.
if [[ "${WITH_SERVERS:-1}" == "1" ]]; then
  echo "==> waiting for the servers to subscribe"
  for HTTP in 7010 7011; do
    for _ in $(seq 1 60); do
      curl -sf "http://127.0.0.1:$HTTP/api/nodes" >/dev/null 2>&1 && break
      sleep 0.5
    done
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
  echo "agent-$NODE $!" >> "$RUN/pids"
done

sleep 3
echo
echo "sandbox up:"
echo "  world     http://127.0.0.1:7100/world"
echo "  broker    mqtt://127.0.0.1:1883  (pw 'sandbox' for every identity)"
if [[ "${WITH_SERVERS:-1}" == "1" ]]; then
  echo "  leader    http://127.0.0.1:7010  (elantris,   postgres :5442)"
  echo "  follower  http://127.0.0.1:7011  (greenhouse, postgres :5443)"
fi
echo "  logs      $RUN/"
cleanup_note
