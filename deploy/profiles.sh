#!/usr/bin/env bash
# Prints the Compose profiles this configuration needs, comma-separated (deploy/compose.sh exports them as
# COMPOSE_PROFILES unless the shell already sets it):
#   ollama    an agent's LLM route is Ollama: LLM_DEFAULT_PROVIDER (default ollama) or any LLM_ROUTES value "ollama"
#   imagegen  art comes from the local sidecar (IMAGEGEN_PROVIDER, default local), or Recraft art is upscaled by
#             the sidecar (IMAGEGEN_PROVIDER=recraft with IMAGEGEN_TOKEN set)
# An all-cloud setup (LLM on nous or anthropic, IMAGEGEN_PROVIDER=fal) prints an empty line: no GPU service runs.
# Reads .env, then .env.worker (later wins, as in compose.sh). Prints profile names only, never values.
#   Usage: deploy/profiles.sh [repository root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Value of the last assignment of KEY in an env file, without surrounding quotes ("" when unset or no file).
value_of() {
  [[ -f "$1" ]] || return 0
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=[[:space:]]*(.*)\$/\\2/p" "$1" | tail -n 1 |
    sed -E "s/[[:space:]]+\$//; s/^'(.*)'\$/\\1/; s/^\"(.*)\"\$/\\1/"
}

setting() {
  local base worker
  base="$(value_of "$ROOT/.env" "$1")"
  worker="$(value_of "$ROOT/.env.worker" "$1")"
  if [[ -n "$worker" ]]; then printf '%s' "$worker"; else printf '%s' "$base"; fi
}

llm_default="$(setting LLM_DEFAULT_PROVIDER)"
routes="$(setting LLM_ROUTES)"
imagegen="$(setting IMAGEGEN_PROVIDER)"
token="$(setting IMAGEGEN_TOKEN)"

profiles=()
if [[ "${llm_default:-ollama}" == "ollama" || "$routes" == *'"ollama"'* ]]; then
  profiles+=(ollama)
fi
if [[ "${imagegen:-local}" == "local" || ("$imagegen" == "recraft" && -n "$token") ]]; then
  profiles+=(imagegen)
fi
(IFS=,; echo "${profiles[*]}")
