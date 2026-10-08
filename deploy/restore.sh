#!/usr/bin/env bash
# Restores a backup written by deploy/backup.sh. DESTRUCTIVE: replaces the database and the blob storage.
#
#   ./deploy/restore.sh /srv/etsy-agents/backups/etsy-agents-20261006T031700Z
#
# Steps: verify checksums -> stop worker and desk -> pg_restore --clean into the running Postgres ->
# replace /data/blobs (keeping blobs/.secrets, the rotated Etsy token) -> start everything again.
# The worker resumes from the restored queue; jobs that were `running` at backup time are requeued by the
# stale-lock check after 15 minutes.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/deploy/compose.sh"

src="${1:-}"
[[ -n "$src" && -d "$src" ]] || { echo "usage: $0 <backup directory>" >&2; exit 2; }
for f in db.dump blobs.tar.gz SHA256SUMS; do
  [[ -f "$src/$f" ]] || { echo "restore: $src/$f is missing" >&2; exit 1; }
done
# sha256sum (Linux) or shasum (macOS).
if command -v sha256sum > /dev/null; then check_sums() { sha256sum --check --quiet SHA256SUMS; }; else check_sums() { shasum -a 256 -c SHA256SUMS > /dev/null; }; fi
( cd "$src" && check_sums ) || { echo "restore: checksum mismatch, refusing" >&2; exit 1; }

echo "This replaces the database and all stored designs with the backup in:"
echo "  $src"
read -r -p "Type RESTORE to continue: " answer
[[ "$answer" == "RESTORE" ]] || { echo "aborted"; exit 1; }

echo "stopping worker and desk"
"$COMPOSE" stop worker desk

echo "starting postgres"
"$COMPOSE" up -d --wait postgres

echo "restoring the database"
# $POSTGRES_USER / $POSTGRES_DB expand inside the container, not here.
# shellcheck disable=SC2016
"$COMPOSE" exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction --exit-on-error' \
  < "$src/db.dump"

echo "restoring blob storage"
"$COMPOSE" run --rm --no-deps -T --entrypoint sh worker -c \
  'find /data/blobs -mindepth 1 -maxdepth 1 ! -name .secrets -exec rm -rf {} + && tar --extract --gzip --file - --directory /data/blobs --no-same-owner' \
  < "$src/blobs.tar.gz"

echo "starting the stack (migrations run first)"
"$COMPOSE" up -d
echo "restore finished. Check: ./deploy/compose.sh run --rm --no-deps worker status"
