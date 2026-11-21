#!/usr/bin/env bash
# Run as root on a host by tools/install-deploy-privileges.sh, with the shipped payload directory as $1.

set -euo pipefail

PAYLOAD="$1"
DEPLOY_USER="${SUDO_USER:?run this through sudo, so the deploy user is known}"
SYSTEMCTL="$(command -v systemctl)"
UNIT_DIR=/etc/systemd/system
SUDOERS_FILE=/etc/sudoers.d/tempestas-deploy
LIBRARY_DIR=/usr/local/lib/tempestas

source "$PAYLOAD/console.sh"
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
  # Verified before anything depends on it: a broken backup unit would block every migration.
  systemd-analyze verify "$PAYLOAD/tempestas-backup.service"
  install -o root -g root -m 0644 "$PAYLOAD/tempestas-backup.service" "$UNIT_DIR/tempestas-backup.service"
  for instance in run revert; do
    install -d -o root -g root -m 0755 "$UNIT_DIR/tempestas-migrate@$instance.service.d"
    install -o root -g root -m 0644 "$PAYLOAD/tempestas-migrate-requires-backup.conf" \
      "$UNIT_DIR/tempestas-migrate@$instance.service.d/requires-backup.conf"
  done
  systemctl daemon-reload
}

allowed_commands=()

if has_installed_unit tempestas-server.service; then
  allowed_commands+=(
    "$SYSTEMCTL start tempestas-migrate@show.service"
    "$SYSTEMCTL restart tempestas-server.service"
    "$SYSTEMCTL reset-failed tempestas-server.service"
  )
  # Docker's Postgres has no postgresql.service to back up through, so changing the schema keeps its password there.
  if has_postgres_service; then
    say "Installing the backup unit, required by every migrate run and revert"
    install_backup_unit
    allowed_commands+=(
      "$SYSTEMCTL start tempestas-backup.service"
      "$SYSTEMCTL start tempestas-migrate@run.service"
      "$SYSTEMCTL start tempestas-migrate@revert.service"
    )
  else
    echo "No postgresql.service here: migrate run and revert still ask for a password, after a hand backup." >&2
  fi
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
