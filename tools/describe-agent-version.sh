#!/usr/bin/env bash
# tools/describe-agent-version.sh <agent app dir>
# Prints <contract major>.<contract minor>.<patch>+<commit>, with -dirty when that agent has uncommitted changes.
# The patch counts this agent's commits since its contract version last changed; see docs/Infrastructure/MQTT Contract.md.

set -euo pipefail

AGENT_DIR="$1"
CONTRACT_FILE="$(git -C "$AGENT_DIR" ls-files --full-name ':(glob)**/contract.py' | head -n 1)"
REPO_ROOT="$(git -C "$AGENT_DIR" rev-parse --show-toplevel)"
CONTRACT_VERSION_LINE='^(SUPPORTED_MAJOR|MQTT_CONTRACT_MINOR) = '

read_contract_number() {
  sed -n "s/^$1 = \([0-9]*\)$/\1/p" "$REPO_ROOT/$CONTRACT_FILE" | head -n 1
}

if [ -z "$CONTRACT_FILE" ]; then
  echo "No contract.py under $AGENT_DIR." >&2
  exit 1
fi

MAJOR="$(read_contract_number SUPPORTED_MAJOR)"
MINOR="$(read_contract_number MQTT_CONTRACT_MINOR)"
if [ -z "$MAJOR" ] || [ -z "$MINOR" ]; then
  echo "No SUPPORTED_MAJOR or MQTT_CONTRACT_MINOR in $CONTRACT_FILE." >&2
  exit 1
fi

CONTRACT_SET_AT="$(git -C "$REPO_ROOT" log -1 --format=%H -E -G "$CONTRACT_VERSION_LINE" -- "$CONTRACT_FILE")"
PATCH="$(git -C "$REPO_ROOT" rev-list --count "${CONTRACT_SET_AT:+$CONTRACT_SET_AT..}HEAD" -- "$AGENT_DIR")"
COMMIT="$(git -C "$AGENT_DIR" rev-parse --short=7 HEAD)"

if [ -n "$(git -C "$AGENT_DIR" status --porcelain -- .)" ]; then
  COMMIT="$COMMIT-dirty"
fi

echo "$MAJOR.$MINOR.$PATCH+$COMMIT"
