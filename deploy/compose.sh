#!/usr/bin/env bash
# Thin wrapper around `docker compose` for this stack: always the same project name, compose file and env
# files (in the repository root), from any working directory.
#   ./deploy/compose.sh up -d --build
#   ./deploy/compose.sh ps
#   ./deploy/compose.sh logs -f worker
#   ./deploy/compose.sh run --rm --no-deps worker status
#
# Env files (mode 600; templates: .env.example, .env.worker.example, .env.desk.example, .env.imagegen.example):
#   .env           shared settings + database, Etsy, Printify   (migrate, worker, desk; compose interpolation)
#   .env.worker    worker-only secrets (imagegen token, Marker, cloud LLM and image keys, Pinterest; also interpolated,
#                  so the imagegen sidecar gets IMAGEGEN_TOKEN)
#   .env.desk      desk-only secrets (password hash, session secret, origin)
#   .env.imagegen  HF_TOKEN for the one-shot model download (optional)
# deploy/check-env.sh runs first and refuses to continue when a file is readable by others or a secret sits in
# a file that other containers read.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT/deploy/check-env.sh" "$ROOT"

# The GPU services run only when the configuration uses them (profiles `ollama`, `imagegen`; deploy/profiles.sh).
# A COMPOSE_PROFILES set in the shell wins, e.g. COMPOSE_PROFILES=ollama,imagegen to start both anyway.
if [[ -z "${COMPOSE_PROFILES+x}" ]]; then
  COMPOSE_PROFILES="$("$ROOT/deploy/profiles.sh" "$ROOT")"
  export COMPOSE_PROFILES
fi

# Interpolation sources, in order (later wins). docker-compose.yml also reads them as `env_file: ../.env*`.
exec docker compose \
  --project-name etsy-agents \
  --project-directory "$ROOT/deploy" \
  --env-file "$ROOT/.env" \
  --env-file "$ROOT/.env.worker" \
  -f "$ROOT/deploy/docker-compose.yml" \
  "$@"
