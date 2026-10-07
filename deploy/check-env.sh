#!/usr/bin/env bash
# Checks the stack's env files before every compose command (deploy/compose.sh runs it first):
#  - .env and .env.worker exist, and every env file is mode 600 (no group/other access)
#  - each secret sits only in the file of the container that uses it (least privilege):
#      DESK_*          .env.desk only (the desk)
#      HF_TOKEN        .env.imagegen only (the one-shot imagegen-download)
#      worker secrets  .env.worker only, never .env (the desk and migrate also read .env):
#                      IMAGEGEN_TOKEN, MARKER_API_*, ANTHROPIC_API_KEY, RECRAFT_API_KEY, IDEOGRAM_API_KEY,
#                      PINTEREST_ACCESS_TOKEN
#      .env.desk holds DESK_* keys only; .env.imagegen holds HF_TOKEN only
#  - OLLAMA_IMAGE, when set (env files or the shell), is pinned by digest
# Prints key names only, never values. Exit code 1 lists every problem found.
#   Usage: deploy/check-env.sh [repository root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

WORKER_SECRETS=" IMAGEGEN_TOKEN MARKER_API_USERNAME MARKER_API_PASSWORD ANTHROPIC_API_KEY RECRAFT_API_KEY IDEOGRAM_API_KEY PINTEREST_ACCESS_TOKEN "

problems=0
problem() {
  echo "check-env: $*" >&2
  problems=$((problems + 1))
}

# Variable names assigned in an env file (KEY=..., optionally `export KEY=...`); comments and blanks ignored.
keys_of() {
  sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*$/\2/p' "$1"
}

# Value of the last assignment of KEY in an env file, without surrounding quotes ("" when unset).
value_of() {
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=[[:space:]]*(.*)\$/\\2/p" "$1" | tail -n 1 |
    sed -E "s/[[:space:]]+\$//; s/^'(.*)'\$/\\1/; s/^\"(.*)\"\$/\\1/"
}

check_mode() {
  local perms
  perms="$(stat -c '%a' "$1")"
  if [[ "${perms: -1}" != "0" || "${perms: -2:1}" != "0" ]]; then
    problem "$1 is readable by group/others (mode $perms). Run: chmod 600 $1"
  fi
}

check_ollama_image() {
  # $1 = where it came from, $2 = value
  if [[ -n "$2" && ! "$2" =~ @sha256:[0-9a-f]{64}$ ]]; then
    problem "OLLAMA_IMAGE ($1) must be pinned by digest: ollama/ollama:<version>@sha256:<64 hex>"
  fi
}

for name in .env .env.worker; do
  if [[ ! -f "$ROOT/$name" ]]; then
    problem "$ROOT/$name not found. Create it: cp $name.example $name && chmod 600 $name (docs/RUNBOOK.md, section 4)"
  fi
done

for name in .env .env.worker .env.desk .env.imagegen; do
  file="$ROOT/$name"
  [[ -f "$file" ]] || continue
  check_mode "$file"
  while IFS= read -r key; do
    case "$name:$key" in
      .env.desk:DESK_*) ;;
      .env.desk:*) problem "$key is not allowed in .env.desk (DESK_* keys only); move it to .env or .env.worker" ;;
      .env.imagegen:HF_TOKEN) ;;
      .env.imagegen:*) problem "$key is not allowed in .env.imagegen (HF_TOKEN only)" ;;
      *:DESK_*) problem "$key belongs in .env.desk (only the desk may read it), not in $name" ;;
      *:HF_TOKEN) problem "HF_TOKEN belongs in .env.imagegen (only imagegen-download reads it), not in $name" ;;
      .env:*)
        if [[ "$WORKER_SECRETS" == *" $key "* ]]; then
          problem "$key belongs in .env.worker, not in .env (the desk and migrate also read .env)"
        fi
        ;;
    esac
  done < <(keys_of "$file")
done

for name in .env .env.worker; do
  if [[ -f "$ROOT/$name" ]]; then
    check_ollama_image "$name" "$(value_of "$ROOT/$name" OLLAMA_IMAGE)"
  fi
done
# The shell environment wins over the env files in compose interpolation.
check_ollama_image "shell environment" "${OLLAMA_IMAGE:-}"

if ((problems > 0)); then
  echo "check-env: $problems problem(s); nothing was started. See docs/RUNBOOK.md, section 4." >&2
  exit 1
fi
