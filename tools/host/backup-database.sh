#!/usr/bin/env bash
# Runs as postgres from tempestas-backup.service; installed to /usr/local/lib/tempestas/backup-database.sh.

set -euo pipefail

BACKUP_DIR=/var/backups/tempestas
DATABASE=tempestas
BACKUPS_KEPT=10

umask 077
BACKUP_FILE="$BACKUP_DIR/$DATABASE-$(date -u +%Y%m%dT%H%M%SZ).dump"
PARTIAL_FILE="$BACKUP_FILE.partial"

# Written aside and renamed, so a dump cut short never looks like a backup.
pg_dump --format=custom --file="$PARTIAL_FILE" "$DATABASE"
mv "$PARTIAL_FILE" "$BACKUP_FILE"
echo "Backup written: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

find "$BACKUP_DIR" -maxdepth 1 -name "$DATABASE-*.dump" -printf '%f\n' |
  sort -r | tail -n +"$((BACKUPS_KEPT + 1))" |
  while read -r expired_backup; do
    rm -- "$BACKUP_DIR/$expired_backup"
    echo "Removed old backup: $expired_backup"
  done
