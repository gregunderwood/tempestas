#!/usr/bin/env bash
# Copies inside the bootloader's grace, before an armed watchdog could reset the board mid-copy.

set -euo pipefail

PORT="${1:-/dev/ttyACM0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HERE/tools/lib/console.sh"
source "$HERE/apps/agent-micropython/agent-files.sh"
DEVICE="$HERE/apps/agent-micropython/device"
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
PORT_WAIT_SECONDS=10
BOARD="$(sed -n 's/^BOARD = "\(.*\)"$/\1/p' "$DEVICE/settings.py")"
BOARD_FILE="$MICROPYTHON_BOARDS_DIRECTORY/$BOARD.py"
SLOT="$MICROPYTHON_USB_DEPLOY_SLOT"
ROOT_FILES=("${MICROPYTHON_BOOTLOADER[@]}" "${MICROPYTHON_NODE_CONFIG[@]}")
# The old flat layout kept these at the root, where they would shadow nothing but waste flash.
FLAT_LAYOUT_FILES=("${MICROPYTHON_AGENT_CODE[@]}" "$MICROPYTHON_BOARD_FILE" "$MICROPYTHON_AGENT_VERSION_STAMP")

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

say "Stamping the version"
AGENT_VERSION="$("$HERE/tools/describe-agent-version.sh" "$HERE/apps/agent-micropython")"
STAMP_FILE="$(mktemp)"
printf 'AGENT_VERSION = "%s"\n' "$AGENT_VERSION" > "$STAMP_FILE"
echo "$AGENT_VERSION"
SLOT_STATE_FILE="$(mktemp)"
trap 'rm -f "$STAMP_FILE" "$SLOT_STATE_FILE"' EXIT
printf '{"active": "%s", "pending": null, "outcome": null}\n' "$SLOT" > "$SLOT_STATE_FILE"

say "Fetching mpremote"
# Fetched before the reset, so none of the boot grace is spent downloading it.
"$UV" tool run mpremote version

say "Resetting the board"
mpremote reset || true
sleep 1
wait_for_port

say "Copying the agent for the $BOARD board into slot $SLOT"
REFUSE_IF_WATCHDOG_ARMED="$(cat "$DEVICE/$BOARD_FILE")
refuse_if_watchdog_armed()"
CLEAR_SLOT_AND_FLAT_LAYOUT="$(cat "$HERE/apps/agent-micropython/usb/clear_slot.py")
clear_slot_and_flat_layout('$SLOT', [$(printf "'%s'," "$MICROPYTHON_SLOT_STATE" "${FLAT_LAYOUT_FILES[@]}")])"
# The slot state is removed first and written last, so a deploy cut short boots nothing rather than half a slot.
(cd "$DEVICE" && mpremote exec "$REFUSE_IF_WATCHDOG_ARMED" + exec "$CLEAR_SLOT_AND_FLAT_LAYOUT" \
  + cp "${MICROPYTHON_AGENT_CODE[@]}" :"$SLOT/" \
  + cp "$BOARD_FILE" :"$SLOT/$MICROPYTHON_BOARD_FILE" \
  + cp "$STAMP_FILE" :"$SLOT/$MICROPYTHON_AGENT_VERSION_STAMP" \
  + cp "${ROOT_FILES[@]}" : \
  + cp "$SLOT_STATE_FILE" :"$MICROPYTHON_SLOT_STATE" \
  + reset)

say "Done. Watch it with: uv tool run mpremote connect $PORT resume repl"
