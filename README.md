# Etsy agent team

Self-hosted multi-agent pipeline for secforit-home: seven agents turn trend signals into original
print-on-demand designs and leave each one as an Etsy **draft**. Razvan edits every design and approves every
listing; nothing goes live without that click. By default all models run locally on the RTX 3060; they can run in
the cloud instead (Nous Research for the agents, fal.ai for the images), in which case the server needs no GPU.

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

## Models (commercial use allowed)

Local (default): Gemma 4 12B via Ollama (`gemma4:12b`, Apache 2.0) for all agents and the vision checks; FLUX.2
[klein] 4B (Apache 2.0) for art; BiRefNet (MIT) for transparent backgrounds; Real-ESRGAN x4plus (BSD-3-Clause) for
print-size upscaling.

Cloud: `LLM_DEFAULT_PROVIDER=nous` runs the agents on open models through the Nous Research inference API;
`IMAGEGEN_PROVIDER=fal` runs the same FLUX.2 klein / BiRefNet / Real-ESRGAN models on fal.ai. Mix per agent with
`LLM_ROUTES`; `deploy/compose.sh` starts only the GPU services the configuration uses, and `worker check-cloud` checks
the keys and models. Setup: [docs/RUNBOOK.md](docs/RUNBOOK.md) section 6. Details and how to swap:
[docs/MODELS.md](docs/MODELS.md).

## Checks

`.github/workflows/ci.yml` runs on every pull request and every push to `main`: typecheck (core, worker, desk),
the TypeScript tests, the offline demo, the desk production build, the sidecar tests, `shellcheck` on `deploy/*.sh`
and `docker compose config` against the env templates. No secrets, no GPU, no network calls from the tests.

## Rollout gates

The desk's **Rollout** page (and `worker status`) tracks the gates from the rollout plan: Gate 2 (50 drafts
reviewed, 60% or more approved, no IP misses) before the daily cap goes from 5 to 10, and Gate 3 (first sales,
cost per published listing at most $0.25, margin close to the model) before it goes higher. See
[docs/RUNBOOK.md](docs/RUNBOOK.md) section 10.
