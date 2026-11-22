#!/usr/bin/env bash
# tools/rollback.sh [host]
# For a problem found after a deploy passed its health check: back to the release it replaced.

set -euo pipefail

HOST="${1:-elantris}"
if [[ "$HOST" == -* ]]; then
  echo "Unknown option $HOST. Usage: tools/rollback.sh [host]" >&2
  exit 2
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

source "$HERE/tools/lib/console.sh"
source "$HERE/tools/lib/remote-host.sh"
source "$HERE/tools/lib/release.sh"

require_passwordless_systemctl "$HOST" "${RELEASE_SYSTEMCTL_LINES[@]}"
require_release_layout "$HOST"

CURRENT_RELEASE_ID="$(read_release_behind "$HOST" current)"
TARGET_RELEASE_ID="$(read_previous_release "$HOST" "$CURRENT_RELEASE_ID")"
if [ -z "$TARGET_RELEASE_ID" ]; then
  echo "$HOST no longer keeps the release $CURRENT_RELEASE_ID replaced, so there is nothing to go back to." >&2
  exit 1
fi

if ! roll_back_release "$HOST" "$CURRENT_RELEASE_ID" "$TARGET_RELEASE_ID"; then
  echo "The rollback did not finish: what $HOST runs now is above." >&2
  exit 1
fi
say "$HOST runs $TARGET_RELEASE_ID"
