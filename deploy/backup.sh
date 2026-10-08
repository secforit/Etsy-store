#!/usr/bin/env bash
# Nightly backup of the Etsy agent team: Postgres (pg_dump, custom format) + blob storage (raw art, edited
# designs, print files), verified, with checksums, rotated after 14 days.
#
#   ./deploy/backup.sh                       # one backup now
#   BACKUP_DIR=/mnt/nas/etsy ./deploy/backup.sh
#
# Cron (as the user that runs Docker), e.g. /etc/cron.d/etsy-agents-backup:
#   17 3 * * * razvan /home/razvan/etsy-agents/deploy/backup.sh >> /var/log/etsy-agents-backup.log 2>&1
#
# Each backup is a directory  $BACKUP_DIR/etsy-agents-<UTC timestamp>/  with db.dump, blobs.tar.gz, SHA256SUMS.
# Secrets are NOT in the backup: .env is not copied, and the rotated Etsy refresh token
# (blobs/.secrets) is excluded. Keep a copy of .env in your password manager. Restore: deploy/restore.sh.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/deploy/compose.sh"
BACKUP_DIR="${BACKUP_DIR:-/srv/etsy-agents/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

# sha256sum (Linux) or shasum (macOS); same output format.
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || fail "BACKUP_KEEP_DAYS must be a whole number of days"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
tmp="$BACKUP_DIR/.partial-$stamp"
mkdir "$tmp"
trap 'rm -rf "$tmp"' EXIT

log "dumping Postgres"
# $POSTGRES_USER / $POSTGRES_DB expand inside the container, not here.
# shellcheck disable=SC2016
"$COMPOSE" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6' \
  > "$tmp/db.dump" || fail "pg_dump"
[[ -s "$tmp/db.dump" ]] || fail "pg_dump produced an empty file"
# A readable table of contents proves the dump is complete and restorable.
"$COMPOSE" exec -T postgres pg_restore --list < "$tmp/db.dump" > /dev/null || fail "pg_restore --list could not read the dump"

log "archiving blob storage"
"$COMPOSE" run --rm --no-deps -T --entrypoint tar worker \
  --create --gzip --file - --directory /data/blobs --exclude ./.secrets . \
  > "$tmp/blobs.tar.gz" || fail "tar of /data/blobs"
tar -tzf "$tmp/blobs.tar.gz" > /dev/null || fail "blob archive is not readable"

( cd "$tmp" && sha256 db.dump blobs.tar.gz > SHA256SUMS )
final="$BACKUP_DIR/etsy-agents-$stamp"
mv "$tmp" "$final"
trap - EXIT
log "wrote $final ($(du -sh "$final" | cut -f1))"

log "removing backups older than $KEEP_DAYS days"
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'etsy-agents-*' -mtime +"$KEEP_DAYS" -print -exec rm -rf {} +
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -mtime +1 -exec rm -rf {} +
log "done"
