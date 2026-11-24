#!/usr/bin/env bash
# tools/deploy-agent-linux.sh [host ...]

set -euo pipefail

REMOTE_AGENT_HOME="${TEMPESTAS_REMOTE_ROOT:-/home/gunderwood/tempestas}/agent-linux"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="$HERE/apps/agent-linux"
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
SETTLE_SECONDS=5
# Written by the venv build beside the venv, so a deploy rebuilds it only when they change.
REQUIREMENTS_FILE=requirements.txt

source "$HERE/tools/lib/console.sh"
source "$HERE/apps/agent-linux/agent-files.sh"
source "$HERE/tools/lib/remote-host.sh"

HOSTS=("$@")
[ "$#" -gt 0 ] || HOSTS=("${LINUX_HOSTS[@]}")

say "Gate"
(cd "$AGENT" && "$UV" run ruff check . && "$UV" run pytest -q)

AGENT_VERSION="$("$HERE/tools/describe-agent-version.sh" "$AGENT")"
REMOTE_RELEASE="$REMOTE_AGENT_HOME/releases/$AGENT_VERSION"
# Without the gpio extra: every host runs the distro's lgpio, which armv6 could not build anyway.
REQUIREMENTS="$(cd "$AGENT" && "$UV" export --frozen --no-dev --no-emit-project --no-hashes --quiet)"
say "Deploying $AGENT_VERSION to ${HOSTS[*]}"

# Every host first: stopping halfway would leave the fleet on two versions.
for HOST in "${HOSTS[@]}"; do
  require_passwordless_systemctl "$HOST" "restart tempestas-agent.service"
done

copy_release() {
  local host="$1"
  ssh "$host" "mkdir -p $REMOTE_RELEASE"
  (cd "$AGENT" && rsync -a --delete --checksum \
    --exclude '__pycache__' --exclude '.venv' --exclude "$(basename "$LINUX_AGENT_VERSION_STAMP")" \
    "${LINUX_AGENT_PATHS[@]}" "$host:$REMOTE_RELEASE/")
  printf 'AGENT_VERSION = "%s"\n' "$AGENT_VERSION" |
    ssh "$host" "cat > $REMOTE_RELEASE/$LINUX_AGENT_VERSION_STAMP"
}

# A fresh venv beside the old one, swapped in only once pip has finished.
build_venv_if_needed() {
  local host="$1"
  printf '%s\n' "$REQUIREMENTS" | ssh "$host" "cat > $REMOTE_AGENT_HOME/.$REQUIREMENTS_FILE"
  ssh "$host" bash -s -- "$REMOTE_AGENT_HOME" "$REQUIREMENTS_FILE" <<'REMOTE'
set -euo pipefail
home="$1" requirements_file="$2"
if cmp -s "$home/.$requirements_file" "$home/venv/$requirements_file"; then
  rm -f "$home/.$requirements_file"
  echo "venv is up to date"
  exit 0
fi
echo "building the venv; on a Pi Zero this takes a few minutes"
rm -rf "$home/.venv-building"
python3 -m venv --system-site-packages "$home/.venv-building"
mv "$home/.$requirements_file" "$home/.venv-building/$requirements_file"
"$home/.venv-building/bin/pip" install --quiet --disable-pip-version-check -r "$home/.venv-building/$requirements_file"
rm -rf "$home/.venv-replaced"
[ ! -e "$home/venv" ] || mv "$home/venv" "$home/.venv-replaced"
mv "$home/.venv-building" "$home/venv"
rm -rf "$home/.venv-replaced"
REMOTE
}

make_current() {
  local host="$1"
  ssh "$host" "cd $REMOTE_RELEASE && TEMPESTAS_AGENT_HOME=$REMOTE_AGENT_HOME PYTHONPATH=$REMOTE_RELEASE/src \
    $REMOTE_AGENT_HOME/venv/bin/python -m tempestas_agent.hand_deploy $AGENT_VERSION"
}

is_unit_on_release_layout() {
  local host="$1"
  ssh "$host" "systemctl cat tempestas-agent.service 2>/dev/null | grep -q '$REMOTE_AGENT_HOME/current'"
}

print_unit_install() {
  local host="$1"
  cat >&2 <<EOF
$host's unit still runs the agent from before the release layout, so it was not restarted.
Once, on $host:
  sudo install -d -m 0755 /usr/local/lib/tempestas
  sudo install -m 0644 -o root -g root $REMOTE_RELEASE/systemd/tempestas-agent-rollback.py /usr/local/lib/tempestas/
  sudo install -m 0644 -o root -g root $REMOTE_RELEASE/systemd/tempestas-agent.service \\
    $REMOTE_RELEASE/systemd/tempestas-agent-rollback.service /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl restart tempestas-agent
EOF
}

for HOST in "${HOSTS[@]}"; do
  say "$HOST: copying into $REMOTE_RELEASE"
  copy_release "$HOST"
  build_venv_if_needed "$HOST"
  make_current "$HOST"

  if ! is_unit_on_release_layout "$HOST"; then
    print_unit_install "$HOST"
    continue
  fi
  say "$HOST: restarting (relays fail safe until the server drives them again)"
  ssh "$HOST" "sudo -n systemctl restart tempestas-agent.service"
  sleep "$SETTLE_SECONDS"
  ssh "$HOST" "systemctl is-active tempestas-agent && journalctl -u tempestas-agent -n 5 --no-pager"
done

say "Done. The Nodes page shows $AGENT_VERSION once each agent has said hello."
