#!/usr/bin/env bash
# Bring up the sandbox: one shared greenhouse, one broker, two node agents.
#
# The topology mirrors what we plan to run on the real hardware - a single
# broker on elantris with greenhouse's agent pointing at it - so "it works in
# the sandbox" is a statement about production and not about a toy.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RUN="${TEMPESTAS_SANDBOX_RUN:-$HERE/.run}"
SPEED="${SPEED:-60}"          # sim minutes per real minute
CO2="${CO2:-700}"
TEMP="${TEMP:-18}"

mkdir -p "$RUN"
: > "$RUN/pids"

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
ACL="$ROOT/apps/hardware/mosquitto/tempestas.acl"
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

for _ in $(seq 1 40); do
  curl -sf localhost:7100/health >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf localhost:7100/health >/dev/null || { echo "sim did not start; see $RUN/sim.log"; exit 1; }

# ---------------------------------------------------------------- agents
for NODE in elantris greenhouse; do
  echo "==> agent $NODE"
  ( cd "$ROOT/apps/hardware" && \
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
echo "  logs      $RUN/"
cleanup_note
