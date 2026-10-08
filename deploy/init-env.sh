#!/usr/bin/env bash
# Creates .env, .env.worker and .env.desk from the templates (mode 600) and fills the generated secrets, the same
# steps as docs/RUNBOOK.md section 4, but portable (Linux and macOS: bash 3.2, BSD sed). Never overwrites a file.
#
#   ./deploy/init-env.sh                        # local models (GPU): also generates IMAGEGEN_TOKEN
#   ./deploy/init-env.sh --cloud                # Nous Research (text) + fal.ai (images), no GPU: asks for both keys
#   ./deploy/init-env.sh --cloud --desk-origin https://mac.<tailnet>.ts.net
#
# --cloud presets (override with the same names in the shell, e.g. NOUS_MODEL_SMALL=... ./deploy/init-env.sh --cloud):
#   NOUS_MODEL_LARGE  deepseek/deepseek-v4-pro     decisions: niche go/no-go, compliance, weekly analysis
#   NOUS_MODEL_SMALL  deepseek/deepseek-v4-flash   workload: trend reading, image prompts, listing copy, QA
#   LLM_TIERS         {"trend_scout":"small","listing_writer":"small"}
#   NOUS_MODEL_VISION not set: pick an image-capable model from `worker check-cloud`
# The desk origin defaults to http://localhost:3000 (the desk on this machine).
# Prints key names only, never values.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cloud=0
desk_origin="http://localhost:3000"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cloud) cloud=1; shift ;;
    --desk-origin) desk_origin="${2:?--desk-origin needs a URL}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "init-env: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done
[[ "$desk_origin" =~ ^https?://[^/]+$ ]] || { echo "init-env: --desk-origin must be an origin like https://host (no path, no trailing slash)" >&2; exit 2; }
command -v openssl > /dev/null || { echo "init-env: openssl is required" >&2; exit 1; }

for name in .env .env.worker .env.desk; do
  if [[ -e "$ROOT/$name" ]]; then
    echo "init-env: $ROOT/$name already exists; nothing was changed. Edit it by hand, or move it away and run again." >&2
    exit 1
  fi
done

# Sets KEY=VALUE in FILE: replaces the first `KEY=` or `# KEY=` line, else appends. The value is passed through the
# environment (no sed/awk escaping) and the file is rewritten in place, so its mode stays 600.
set_key() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp "$ROOT/.init-env.XXXXXX")"
  KEY="$key" LINE="$key=$value" awk '
    !done && ($0 ~ "^" ENVIRON["KEY"] "=" || $0 ~ "^# ?" ENVIRON["KEY"] "=") { print ENVIRON["LINE"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["LINE"] }
  ' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

# Comments out an active `KEY=...` line.
comment_key() {
  local file="$1" key="$2" tmp
  tmp="$(mktemp "$ROOT/.init-env.XXXXXX")"
  KEY="$key" awk '$0 ~ "^" ENVIRON["KEY"] "=" { print "# " $0; next } { print }' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

# Reads a secret without echoing it ("" when stdin is not a terminal or nothing was typed).
ask_secret() {
  local prompt="$1" value=""
  if [[ -t 0 ]]; then
    read -r -s -p "$prompt" value || true
    echo >&2
  fi
  printf '%s' "$value"
}

for name in .env .env.worker .env.desk; do
  cp "$ROOT/$name.example" "$ROOT/$name"
  chmod 600 "$ROOT/$name"
done

set_key "$ROOT/.env" POSTGRES_PASSWORD "$(openssl rand -hex 24)"
set_key "$ROOT/.env.desk" DESK_SESSION_SECRET "'$(openssl rand -base64 48 | tr -d '\n')'"
set_key "$ROOT/.env.desk" DESK_ORIGIN "$desk_origin"

if [[ "$cloud" == 1 ]]; then
  set_key "$ROOT/.env.worker" LLM_DEFAULT_PROVIDER nous
  set_key "$ROOT/.env.worker" NOUS_MODEL_LARGE "${NOUS_MODEL_LARGE:-deepseek/deepseek-v4-pro}"
  set_key "$ROOT/.env.worker" NOUS_MODEL_SMALL "${NOUS_MODEL_SMALL:-deepseek/deepseek-v4-flash}"
  if [[ -n "${NOUS_MODEL_VISION:-}" ]]; then set_key "$ROOT/.env.worker" NOUS_MODEL_VISION "$NOUS_MODEL_VISION"; fi
  default_tiers='{"trend_scout":"small","listing_writer":"small"}'
  set_key "$ROOT/.env.worker" LLM_TIERS "'${LLM_TIERS:-$default_tiers}'"
  set_key "$ROOT/.env.worker" IMAGEGEN_PROVIDER fal
  comment_key "$ROOT/.env.worker" IMAGEGEN_TOKEN
  nous_key="$(ask_secret 'Nous API key (portal.nousresearch.com; Enter to skip): ')"
  if [[ -n "$nous_key" ]]; then set_key "$ROOT/.env.worker" NOUS_API_KEY "$nous_key"; fi
  fal_key="$(ask_secret 'fal API key (fal.ai/dashboard/keys; Enter to skip): ')"
  if [[ -n "$fal_key" ]]; then set_key "$ROOT/.env.worker" FAL_KEY "$fal_key"; fi
else
  set_key "$ROOT/.env.worker" IMAGEGEN_TOKEN "$(openssl rand -hex 32)"
fi

echo "Created .env, .env.worker and .env.desk (mode 600) with POSTGRES_PASSWORD, DESK_SESSION_SECRET and DESK_ORIGIN=$desk_origin."
if [[ "$cloud" == 1 ]]; then
  echo "Cloud models: LLM_DEFAULT_PROVIDER=nous, IMAGEGEN_PROVIDER=fal, NOUS_MODEL_LARGE/SMALL and LLM_TIERS set."
  [[ -n "${nous_key:-}" ]] || echo "  Still to do: NOUS_API_KEY in .env.worker."
  [[ -n "${fal_key:-}" ]] || echo "  Still to do: FAL_KEY in .env.worker."
  [[ -n "${NOUS_MODEL_VISION:-}" ]] || echo "  Still to do: NOUS_MODEL_VISION in .env.worker (check-cloud lists the image-capable models)."
else
  echo "Local models: IMAGEGEN_TOKEN generated."
fi
cat <<EOF
Next:
  ./deploy/compose.sh build
  ./deploy/compose.sh run --rm --no-deps worker hash-password     # paste into .env.desk IN SINGLE QUOTES:
                                                                   #   DESK_PASSWORD_HASH='scrypt\$...'
EOF
if [[ "$cloud" == 1 ]]; then echo "  ./deploy/compose.sh run --rm --no-deps worker check-cloud       # keys, models, prices, agent -> model map"; fi
cat <<EOF
  ./deploy/compose.sh up -d                                        # MODE=mock first (offline mocks)
Then open $desk_origin in your browser.
EOF
