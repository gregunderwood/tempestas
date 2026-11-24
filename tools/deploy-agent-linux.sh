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

# Staged apart from an update's download of the same version, then put in place in one step.
copy_release() {
  local host="$1"
  local releases="$REMOTE_AGENT_HOME/releases"
  local staging=".deploy-$AGENT_VERSION"
  ssh "$host" "rm -rf $releases/$staging && mkdir -p $releases/$staging"
  (cd "$AGENT" && rsync -a \
    --exclude '__pycache__' --exclude '.venv' --exclude "$(basename "$LINUX_AGENT_VERSION_STAMP")" \
    "${LINUX_AGENT_PATHS[@]}" "$host:$releases/$staging/")
  printf 'AGENT_VERSION = "%s"\n' "$AGENT_VERSION" |
    ssh "$host" "cat > $releases/$staging/$LINUX_AGENT_VERSION_STAMP"
  ssh "$host" bash -s -- "$releases" "$staging" "$AGENT_VERSION" <<'REMOTE'
set -euo pipefail
cd "$1"
staging="$2" release="$3"
if [ ! -e "$release" ]; then
  mv -T "$staging" "$release"
elif ! mv -T --exchange "$staging" "$release" 2>/dev/null; then
  # coreutils before 9.5 cannot exchange, so `current` points at nothing for a moment.
  rm -rf "$staging-replaced"
  mv -T "$release" "$staging-replaced"
  mv -T "$staging" "$release"
  mv -T "$staging-replaced" "$staging"
fi
rm -rf "$staging"
REMOTE
}

# Built beside the running venv, which the agent keeps using until swap_in_built_venv.
build_venv_if_needed() {
  local host="$1"
  printf '%s\n' "$REQUIREMENTS" | ssh "$host" "cat > $REMOTE_AGENT_HOME/.$REQUIREMENTS_FILE"
  ssh "$host" bash -s -- "$REMOTE_AGENT_HOME" "$REQUIREMENTS_FILE" <<'REMOTE'
set -euo pipefail
home="$1" requirements_file="$2"
rm -rf "$home/.venv-building"
if cmp -s "$home/.$requirements_file" "$home/venv/$requirements_file"; then
  rm -f "$home/.$requirements_file"
  echo "venv is up to date"
  exit 0
fi
echo "building the venv; on a Pi Zero this takes a few minutes"
python3 -m venv --system-site-packages "$home/.venv-building"
"$home/.venv-building/bin/pip" install --quiet --disable-pip-version-check -r "$home/.$requirements_file"
# Last, so only a finished build carries the file swap_in_built_venv looks for.
mv "$home/.$requirements_file" "$home/.venv-building/$requirements_file"
REMOTE
}

# Just before the restart, so the old agent never runs against packages it was not built for.
swap_in_built_venv() {
  local host="$1"
  ssh "$host" bash -s -- "$REMOTE_AGENT_HOME" "$REQUIREMENTS_FILE" <<'REMOTE'
set -euo pipefail
home="$1" requirements_file="$2"
[ -e "$home/.venv-building/$requirements_file" ] || exit 0
rm -rf "$home/.venv-replaced"
[ ! -e "$home/venv" ] || mv "$home/venv" "$home/.venv-replaced"
mv "$home/.venv-building" "$home/venv"
REMOTE
}

# Only once the agent has restarted onto the new venv, as the old one ran from it until then.
remove_replaced_venv() {
  local host="$1"
  ssh "$host" "rm -rf $REMOTE_AGENT_HOME/.venv-replaced"
}

# The system python: hand_deploy needs only the standard library, and the venv may not exist yet.
make_current() {
  local host="$1"
  ssh "$host" "cd $REMOTE_RELEASE && TEMPESTAS_AGENT_HOME=$REMOTE_AGENT_HOME PYTHONPATH=$REMOTE_RELEASE/src \
    python3 -m tempestas_agent.hand_deploy $AGENT_VERSION"
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
    swap_in_built_venv "$HOST"
    remove_replaced_venv "$HOST"
    print_unit_install "$HOST"
    continue
  fi
  say "$HOST: restarting (relays fail safe until the server drives them again)"
  swap_in_built_venv "$HOST"
  ssh "$HOST" "sudo -n systemctl restart tempestas-agent.service"
  remove_replaced_venv "$HOST"
  sleep "$SETTLE_SECONDS"
  ssh "$HOST" "systemctl is-active tempestas-agent && journalctl -u tempestas-agent -n 5 --no-pager"
done

say "Done. The Nodes page shows $AGENT_VERSION once each agent has said hello."
