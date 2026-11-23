#!/usr/bin/env bash
# tools/deploy-agent-linux.sh [host ...]

set -euo pipefail

REMOTE_AGENT="/home/gunderwood/tempestas/apps/agent-linux"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="$HERE/apps/agent-linux"
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
SETTLE_SECONDS=5

source "$HERE/tools/lib/console.sh"
source "$HERE/apps/agent-linux/agent-files.sh"
source "$HERE/tools/lib/remote-host.sh"

HOSTS=("$@")
[ "$#" -gt 0 ] || HOSTS=("${LINUX_HOSTS[@]}")

say "Gate"
(cd "$AGENT" && "$UV" run ruff check . && "$UV" run pytest -q)

AGENT_VERSION="$("$HERE/tools/describe-agent-version.sh" "$AGENT")"
say "Deploying $AGENT_VERSION to ${HOSTS[*]}"

# Every host first: stopping halfway would leave the fleet on two versions.
for HOST in "${HOSTS[@]}"; do
  require_passwordless_systemctl "$HOST" "restart tempestas-agent.service"
done

for HOST in "${HOSTS[@]}"; do
  say "$HOST: copying"
  CHANGES="$(cd "$AGENT" && rsync -a --checksum --itemize-changes \
    --exclude '__pycache__' --exclude '.venv' --exclude 'deployed_version.py' \
    "${LINUX_AGENT_PATHS[@]}" "$HOST:$REMOTE_AGENT/")"
  echo "$(echo "$CHANGES" | grep -c '^<f' || true) files updated"
  # The venv is an editable install, so new code needs no reinstall; new dependencies do.
  if echo "$CHANGES" | grep -qE ' (pyproject\.toml|uv\.lock)$'; then
    echo "Dependencies may have changed: run 'uv sync --extra gpio' in $REMOTE_AGENT on $HOST." >&2
  fi
  printf 'AGENT_VERSION = "%s"\n' "$AGENT_VERSION" |
    ssh "$HOST" "cat > $REMOTE_AGENT/$LINUX_AGENT_VERSION_STAMP"

  say "$HOST: restarting (relays fail safe until the server drives them again)"
  ssh "$HOST" "sudo -n systemctl restart tempestas-agent.service"
  sleep "$SETTLE_SECONDS"
  ssh "$HOST" "systemctl is-active tempestas-agent && journalctl -u tempestas-agent -n 5 --no-pager"
done

say "Done. The Nodes page shows $AGENT_VERSION once each agent has said hello."
