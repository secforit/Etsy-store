# Etsy agent team

Self-hosted multi-agent pipeline for secforit-home: seven agents turn trend signals into original
print-on-demand designs and leave each one as an Etsy **draft**. Razvan edits every design and approves every
listing; nothing goes live without that click. All models run locally on the RTX 3060.

Architecture doc: https://claude.ai/code/artifact/e5795e3b-3519-4911-9672-77a11215c48e

## Try it first (no keys, no GPU)

```bash
npm install
MODE=mock npm run demo     # full pipeline on offline mocks: trend -> design -> your edit -> draft -> approval -> analytics
npm test                   # TypeScript tests
cd apps/imagegen && uv venv --python 3.12 && uv pip install -e '.[dev]' && .venv/bin/python -m pytest -q   # sidecar tests (fake pipelines, no GPU)
```

## Run it on the server

Follow [docs/RUNBOOK.md](docs/RUNBOOK.md): Docker + NVIDIA Container Toolkit, env files, `deploy/compose.sh up -d`,
model downloads, `tailscale serve` for the desk, mock run, then the going-live checklist.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | Domain types, state machine, Postgres schema, integrations (Etsy, Printify, Marker, trends, GPU, storage), LLM clients (Ollama, optional Anthropic), the seven agents, orchestrator, desk service |
| `apps/worker` | CLI: `migrate`, `run`, `demo`, `setup-catalog`, `hash-password`, `check-gpu` |
| `apps/desk` | Approval desk (Next.js), single-user login, served on 127.0.0.1 and reached over Tailscale |
| `apps/imagegen` | GPU sidecar (FastAPI): FLUX.2 [klein] 4B, BiRefNet, Real-ESRGAN |
| `deploy` | Docker Compose, Dockerfile, env checks, backup and restore |
| `docs` | `RUNBOOK.md` (operations), `MODELS.md` (models and licenses), `BUILD_SPEC.md` (design rules) |

## Models (local, commercial use allowed)

Gemma 4 12B via Ollama (`gemma4:12b`, Apache 2.0) for all agents and the vision checks; FLUX.2 [klein] 4B
(Apache 2.0) for art; BiRefNet (MIT) for transparent backgrounds; Real-ESRGAN x4plus (BSD-3-Clause) for print-size
upscaling. Details and how to swap: [docs/MODELS.md](docs/MODELS.md).

## Git history

The full history ships as `etsy-agents.bundle`. To restore it in this folder:

```bash
git init -b master && git fetch etsy-agents.bundle master && git reset FETCH_HEAD && git status
```
