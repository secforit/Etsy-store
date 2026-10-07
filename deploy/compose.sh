#!/usr/bin/env bash
# Thin wrapper around `docker compose` for this stack: always the same project name, compose file and
# env file (the repository's .env), from any working directory.
#   ./deploy/compose.sh up -d --build
#   ./deploy/compose.sh ps
#   ./deploy/compose.sh logs -f worker
#   ./deploy/compose.sh run --rm --no-deps worker status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Fixed location: docker-compose.yml also reads it as `env_file: ../.env`.
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "compose.sh: $ENV_FILE not found. Create it first: cp .env.example .env && chmod 600 .env" >&2
  exit 1
fi

# .env holds every secret: refuse to run when other users can read it.
perms="$(stat -c '%a' "$ENV_FILE")"
if [[ "${perms: -1}" != "0" || "${perms: -2:1}" != "0" ]]; then
  echo "compose.sh: $ENV_FILE is readable by group/others (mode $perms). Run: chmod 600 $ENV_FILE" >&2
  exit 1
fi

exec docker compose \
  --project-name etsy-agents \
  --project-directory "$ROOT/deploy" \
  --env-file "$ENV_FILE" \
  -f "$ROOT/deploy/docker-compose.yml" \
  "$@"
