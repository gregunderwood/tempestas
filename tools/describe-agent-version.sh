#!/usr/bin/env bash
# tools/describe-agent-version.sh <agent app dir>
# Prints <contract major>.<contract minor>.<patch>, and marks anything but a clean origin/main as -dev+<commit>.
# The patch counts commits to this agent, or to the list of files it ships, since its contract version last changed; see docs/Infrastructure/MQTT Contract.md.

set -euo pipefail

AGENT_DIR="$1"
CONTRACT_FILE="$(git -C "$AGENT_DIR" ls-files --full-name ':(glob)**/contract.py' | head -n 1)"
REPO_ROOT="$(git -C "$AGENT_DIR" rev-parse --show-toplevel)"
CONTRACT_VERSION_LINE='^(SUPPORTED_MAJOR|MQTT_CONTRACT_MINOR) = '
AGENT_FILE_LIST="$REPO_ROOT/tools/lib/agent-files.sh"

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
PATCH="$(git -C "$REPO_ROOT" rev-list --count "${CONTRACT_SET_AT:+$CONTRACT_SET_AT..}HEAD" -- "$AGENT_DIR" "$AGENT_FILE_LIST")"
VERSION="$MAJOR.$MINOR.$PATCH"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short=7 HEAD)"
RELEASED_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short=7 --verify --quiet origin/main || true)"
HAS_UNCOMMITTED_CHANGES="$(git -C "$REPO_ROOT" status --porcelain -- "$AGENT_DIR" "$AGENT_FILE_LIST")"

if [ -n "$HAS_UNCOMMITTED_CHANGES" ]; then
  echo "$VERSION-dev+$COMMIT.dirty"
elif [ "$COMMIT" != "$RELEASED_COMMIT" ]; then
  echo "$VERSION-dev+$COMMIT"
else
  echo "$VERSION"
fi
