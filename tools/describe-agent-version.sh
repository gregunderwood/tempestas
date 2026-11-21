#!/usr/bin/env bash
# tools/describe-agent-version.sh <agent app dir>
# Prints <pyproject version>+<commit>, with -dirty when that agent has uncommitted changes.

set -euo pipefail

AGENT_DIR="$1"
PACKAGE_VERSION="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$AGENT_DIR/pyproject.toml" | head -n 1)"
COMMIT="$(git -C "$AGENT_DIR" rev-parse --short=7 HEAD)"

if [ -z "$PACKAGE_VERSION" ]; then
  echo "No version in $AGENT_DIR/pyproject.toml." >&2
  exit 1
fi

if [ -n "$(git -C "$AGENT_DIR" status --porcelain -- .)" ]; then
  COMMIT="$COMMIT-dirty"
fi

echo "$PACKAGE_VERSION+$COMMIT"
