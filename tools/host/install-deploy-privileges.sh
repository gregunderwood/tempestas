#!/usr/bin/env bash
# Run as root on a host by tools/install-deploy-privileges.sh, with the shipped payload directory as $1.

set -euo pipefail

PAYLOAD="$1"
DEPLOY_USER="${SUDO_USER:?run this through sudo, so the deploy user is known}"
SYSTEMCTL=/usr/bin/systemctl
UNIT_DIR=/etc/systemd/system
SUDOERS_FILE=/etc/sudoers.d/tempestas-deploy
LIBRARY_DIR=/usr/local/lib/tempestas

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
has_installed_unit() { [ -f "$UNIT_DIR/$1" ]; }
has_postgres_service() { systemctl cat postgresql.service >/dev/null 2>&1; }

join_with_commas() {
  local joined="$1"
  shift
  for item in "$@"; do
    joined="$joined, $item"
  done
  echo "$joined"
}

install_backup_unit() {
  install -d -o root -g root -m 0755 "$LIBRARY_DIR"
  install -o root -g root -m 0755 "$PAYLOAD/backup-database.sh" "$LIBRARY_DIR/backup-database.sh"
  install -o root -g root -m 0644 "$PAYLOAD/tempestas-backup.service" "$UNIT_DIR/tempestas-backup.service"
  systemctl daemon-reload
  systemd-analyze verify "$UNIT_DIR/tempestas-backup.service"
}

allowed_commands=()

if has_installed_unit tempestas-server.service; then
  # A host whose Postgres runs in Docker has no postgresql.service for the backup unit to require.
  if has_postgres_service; then
    say "Installing the backup unit"
    install_backup_unit
    allowed_commands+=("$SYSTEMCTL start tempestas-backup.service")
  else
    echo "No postgresql.service here, so no backup unit: back up by hand before migrating." >&2
  fi
  allowed_commands+=(
    "$SYSTEMCTL start tempestas-migrate@show.service"
    "$SYSTEMCTL start tempestas-migrate@run.service"
    "$SYSTEMCTL start tempestas-migrate@revert.service"
    "$SYSTEMCTL restart tempestas-server.service"
    "$SYSTEMCTL reset-failed tempestas-server.service"
  )
fi

if has_installed_unit tempestas-agent.service; then
  allowed_commands+=("$SYSTEMCTL restart tempestas-agent.service")
fi

if [ "${#allowed_commands[@]}" -eq 0 ]; then
  echo "No tempestas units are installed here; nothing to allow." >&2
  exit 1
fi

say "Writing $SUDOERS_FILE"
candidate="$(mktemp)"
trap 'rm -f "$candidate"' EXIT
{
  echo "# Exact command lines only: a wildcard here is a root shell."
  echo "$DEPLOY_USER ALL=(root) NOPASSWD: $(join_with_commas "${allowed_commands[@]}")"
} >"$candidate"

# Checked before it lands: a broken file in sudoers.d disables sudo for everyone.
visudo -cf "$candidate"
install -o root -g root -m 0440 "$candidate" "$SUDOERS_FILE"

say "$DEPLOY_USER may now run without a password:"
printf '  sudo %s\n' "${allowed_commands[@]}"
