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
# Older systemd reaches `failed` only at the start limit, so OnFailure= cannot judge each run.
MINIMUM_SYSTEMD_VERSION=254
# The lock the agent's installer holds while it replaces a release of the same name.
SWITCH_LOCK=update-state/switch.lock
ROLLBACK_SCRIPT_DIR=/usr/local/lib/tempestas
UNIT_DIR=/etc/systemd/system

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

# A warning, not a refusal: a hand deploy must still reach such a host with a fix.
warn_unless_systemd_rolls_back() {
  local host="$1" version
  version="$(ssh "$host" "systemctl --version" | awk 'NR == 1 { print $2 }')"
  [ "$version" -ge "$MINIMUM_SYSTEMD_VERSION" ] && return 0
  echo "WARNING: $host runs systemd $version; rolling back a failed update needs $MINIMUM_SYSTEMD_VERSION or later." >&2
  echo "         Do not send it updates from the server until it is upgraded." >&2
}

# Every host first: stopping halfway would leave the fleet on two versions.
for HOST in "${HOSTS[@]}"; do
  require_passwordless_systemctl "$HOST" "restart tempestas-agent.service"
  warn_unless_systemd_rolls_back "$HOST"
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
  ssh "$host" bash -s -- "$releases" "$staging" "$AGENT_VERSION" "$REMOTE_AGENT_HOME/$SWITCH_LOCK" <<'REMOTE'
set -euo pipefail
cd "$1"
staging="$2" release="$3" switch_lock="$4"
mkdir -p "$(dirname "$switch_lock")"
exec {lock_descriptor}>"$switch_lock"
flock "$lock_descriptor"
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
# First, so a .venv-replaced afterwards always means this deploy swapped.
rm -rf "$home/.venv-replaced"
[ -e "$home/.venv-building/$requirements_file" ] || exit 0
[ ! -e "$home/venv" ] || mv "$home/venv" "$home/.venv-replaced"
mv "$home/.venv-building" "$home/venv"
REMOTE
}

# When `current` could not follow, so the running release keeps the packages it was built for.
swap_back_venv() {
  local host="$1"
  ssh "$host" "[ ! -e $REMOTE_AGENT_HOME/.venv-replaced ] || \
    { rm -rf $REMOTE_AGENT_HOME/venv && mv $REMOTE_AGENT_HOME/.venv-replaced $REMOTE_AGENT_HOME/venv; }"
}

make_current_or_swap_back() {
  local host="$1"
  make_current "$host" && return 0
  echo "$host: could not make $AGENT_VERSION current, so its venv was put back" >&2
  swap_back_venv "$host"
  exit 1
}

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

# Root-owned, so a deploy cannot install them itself; it says when they differ from the release's.
are_unit_files_current() {
  local host="$1"
  ssh "$host" "cmp -s $REMOTE_RELEASE/systemd/tempestas-agent-rollback.py $ROLLBACK_SCRIPT_DIR/tempestas-agent-rollback.py \
    && cmp -s $REMOTE_RELEASE/systemd/tempestas-agent.service $UNIT_DIR/tempestas-agent.service \
    && cmp -s $REMOTE_RELEASE/systemd/tempestas-agent-rollback.service $UNIT_DIR/tempestas-agent-rollback.service"
}

print_unit_install() {
  local host="$1" reason="$2"
  cat >&2 <<EOF
$host: $reason
On $host:
  sudo install -d -m 0755 $ROLLBACK_SCRIPT_DIR
  sudo install -m 0644 -o root -g root $REMOTE_RELEASE/systemd/tempestas-agent-rollback.py $ROLLBACK_SCRIPT_DIR/
  sudo install -m 0644 -o root -g root $REMOTE_RELEASE/systemd/tempestas-agent.service \\
    $REMOTE_RELEASE/systemd/tempestas-agent-rollback.service $UNIT_DIR/
  sudo systemctl daemon-reload && sudo systemctl restart tempestas-agent
EOF
}

for HOST in "${HOSTS[@]}"; do
  say "$HOST: copying into $REMOTE_RELEASE"
  copy_release "$HOST"
  build_venv_if_needed "$HOST"

  if ! is_unit_on_release_layout "$HOST"; then
    swap_in_built_venv "$HOST"
    make_current_or_swap_back "$HOST"
    remove_replaced_venv "$HOST"
    print_unit_install "$HOST" "its unit still runs the agent from before the release layout, so it was not restarted."
    continue
  fi
  say "$HOST: restarting (relays fail safe until the server drives them again)"
  # Back to back, then restarted: any start between them would pair code with the wrong venv.
  swap_in_built_venv "$HOST"
  make_current_or_swap_back "$HOST"
  ssh "$HOST" "sudo -n systemctl restart tempestas-agent.service"
  sleep "$SETTLE_SECONDS"
  ssh "$HOST" "systemctl is-active tempestas-agent && journalctl -u tempestas-agent -n 5 --no-pager"
  # Only once the agent runs on the new venv, so a broken build leaves the old one to swap back.
  remove_replaced_venv "$HOST"
  are_unit_files_current "$HOST" ||
    print_unit_install "$HOST" "the installed unit files or rollback script differ from this release's."
done

say "Done. The Nodes page shows $AGENT_VERSION once each agent has said hello."
