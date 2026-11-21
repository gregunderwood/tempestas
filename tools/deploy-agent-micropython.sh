#!/usr/bin/env bash
# Copies inside main.py's boot grace, before an armed watchdog could reset the board mid-copy.

set -euo pipefail

PORT="${1:-/dev/ttyACM0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVICE="$HERE/apps/agent-micropython/device"
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
PORT_WAIT_SECONDS=10
BOARD="$(sed -n 's/^BOARD = "\(.*\)"$/\1/p' "$DEVICE/settings.py")"
BOARD_FILE="boards/$BOARD.py"
AGENT_FILES=(
  main.py node_runtime.py node_agent.py tempestas_mqtt.py command_guard.py contract.py
  iso_time.py relay_lines.py ds18b20_probes.py settings.py credentials.py
)

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
mpremote() { "$UV" tool run mpremote connect "$PORT" "$@"; }

wait_for_port() {
  for _ in $(seq "$PORT_WAIT_SECONDS"); do
    [ -e "$PORT" ] && return 0
    sleep 1
  done
  echo "$PORT did not come back after the reset." >&2
  exit 1
}

if [ ! -f "$DEVICE/$BOARD_FILE" ]; then
  echo "settings.BOARD is \"$BOARD\", but there is no device/$BOARD_FILE." >&2
  exit 1
fi

if [ ! -f "$DEVICE/credentials.py" ]; then
  echo "No apps/agent-micropython/device/credentials.py. Copy credentials.example.py and fill it in." >&2
  exit 1
fi

say "Gate"
(cd "$HERE/apps/agent-micropython" && "$UV" run ruff check . && "$UV" run pytest -q)

say "Fetching mpremote"
# Fetched before the reset, so none of the boot grace is spent downloading it.
"$UV" tool run mpremote version

say "Resetting the board"
mpremote reset || true
sleep 1
wait_for_port

say "Copying the agent for the $BOARD board"
REFUSE_IF_WATCHDOG_ARMED="$(cat "$DEVICE/$BOARD_FILE")
refuse_if_watchdog_armed()"
(cd "$DEVICE" && mpremote exec "$REFUSE_IF_WATCHDOG_ARMED" + cp "${AGENT_FILES[@]}" : + cp "$BOARD_FILE" :board.py + reset)

say "Done. Watch it with: uv tool run mpremote connect $PORT resume repl"
