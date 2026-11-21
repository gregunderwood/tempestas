#!/usr/bin/env bash
# tools/deploy-agent-linux.sh [host ...]

set -euo pipefail

DEFAULT_HOSTS=(elantris patji)
HOSTS=("$@")
[ "$#" -gt 0 ] || HOSTS=("${DEFAULT_HOSTS[@]}")
REMOTE_AGENT="/home/gunderwood/tempestas/apps/agent-linux"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="$HERE/apps/agent-linux"
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
SETTLE_SECONDS=5
SHIPPED=(src tools nodes systemd pyproject.toml uv.lock agent.example.toml)

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Gate"
(cd "$AGENT" && "$UV" run ruff check . && "$UV" run pytest -q)

AGENT_VERSION="$("$HERE/tools/describe-agent-version.sh" "$AGENT")"
say "Deploying $AGENT_VERSION to ${HOSTS[*]}"

for HOST in "${HOSTS[@]}"; do
  say "$HOST: copying"
  CHANGES="$(cd "$AGENT" && rsync -a --checksum --itemize-changes \
    --exclude '__pycache__' --exclude '.venv' --exclude 'deployed_version.py' \
    "${SHIPPED[@]}" "$HOST:$REMOTE_AGENT/")"
  echo "$(echo "$CHANGES" | grep -c '^<f' || true) files updated"
  # The venv is an editable install, so new code needs no reinstall; new dependencies do.
  if echo "$CHANGES" | grep -qE ' (pyproject\.toml|uv\.lock)$'; then
    echo "Dependencies may have changed: run 'uv sync --extra gpio' in $REMOTE_AGENT on $HOST." >&2
  fi
  printf 'AGENT_VERSION = "%s"\n' "$AGENT_VERSION" |
    ssh "$HOST" "cat > $REMOTE_AGENT/src/tempestas_agent/deployed_version.py"

  say "$HOST: restarting (relays fail safe until the server drives them again)"
  ssh -t "$HOST" "sudo systemctl restart tempestas-agent.service"
  sleep "$SETTLE_SECONDS"
  ssh "$HOST" "systemctl is-active tempestas-agent && journalctl -u tempestas-agent -n 5 --no-pager"
done

say "Done. The Nodes page shows $AGENT_VERSION once each agent has said hello."
