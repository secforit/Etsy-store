# imagegen sidecar

Python 3.12 FastAPI service that runs the image models on the RTX 3060 for the worker: FLUX.2 [klein] 4B
(text to image), BiRefNet (transparent background) and Real-ESRGAN x4plus (upscaling). Model choices, licences,
VRAM and swapping: [`docs/MODELS.md`](../../docs/MODELS.md). TypeScript client:
`packages/core/src/integrations/imagegen.ts`.

## API

Every route requires `Authorization: Bearer $IMAGEGEN_TOKEN` (constant-time check, 401 otherwise). Plain HTTP on
the private Docker network only (`http://imagegen:8000`); compose publishes no port.

| Route | Request | Response |
| --- | --- | --- |
| `POST /generate` | JSON `{prompt, width, height, seed?, transparent}`; prompt 1–2000 chars; width/height multiples of 16 in 256–2048; seed 0–2^53-1; strict types, unknown fields rejected | `image/png` (RGB, or RGBA when `transparent`) + header `x-seed` |
| `POST /upscale?factor=2\|4` | body `image/png`, ≤ 50 MB, output ≤ 12000 px per side | `image/png` at exactly factor × the input (alpha kept) |
| `POST /unload` | empty | `204`; every model dropped and `torch.cuda.empty_cache()` |
| `GET /healthz` | – | `{"ok": true, "loaded": ["flux2-klein-4b", ...], "busy": false}` |

Errors are JSON `{"error": "<code>"}`: 400 `invalid_json`/`invalid_png`, 401 `unauthorized`, 413 `body_too_large`,
415 `unsupported_media_type`, 422 `invalid_request`/`image_too_large`, 503 `busy`/`model_unavailable`/
`gpu_out_of_memory` (with `Retry-After`), 500 `internal_error`. Error bodies never echo request content or paths.

Behaviour:

- Models load lazily on first use (the first `/generate` after start or `/unload` takes longer).
- One GPU job at a time: a bounded queue feeds a single GPU thread. A request that cannot start within
  `IMAGEGEN_QUEUE_TIMEOUT_S` (default 240) gets 503 `busy`; a job that started always finishes before the next.
- `transparent: true` appends a "plain pure white background" instruction to the prompt, cuts the subject out with
  BiRefNet, snaps near-0/near-255 alpha, and removes the white halo from edge pixels (blur-fusion foreground estimate).
- `factor=2` runs the x4 model and downsamples each tile on the GPU (antialiased bicubic).
- CUDA out of memory: every model is unloaded and the request gets 503 + `Retry-After: 5`, so the client's single
  retry starts on an empty card.

## Configuration (environment)

| Variable | Default | Notes |
| --- | --- | --- |
| `IMAGEGEN_TOKEN` / `IMAGEGEN_TOKEN_FILE` | – (required, ≥ 24 chars) | `openssl rand -hex 32` |
| `HF_HOME` | `/models` | Hugging Face cache (the `hf-models` volume) |
| `HF_HUB_OFFLINE` or `IMAGEGEN_OFFLINE` | `0` | `1` after `python -m imagegen.download`: no network at all |
| `IMAGEGEN_DEVICE` | `cuda` | `cuda`, `cuda:N` or `cpu` (CPU is for debugging only) |
| `IMAGEGEN_FLUX_CPU_OFFLOAD` | `1` | keep on for 12 GB cards |
| `IMAGEGEN_UPSCALE_TILE` / `_TILE_PAD` | `512` / `16` | tiles halve automatically on CUDA OOM (min 128) |
| `IMAGEGEN_QUEUE_TIMEOUT_S` | `240` | |
| `IMAGEGEN_FLUX_REPO`, `_FLUX_REVISION`, `_BIREFNET_REPO`, `_BIREFNET_REVISION`, `_ESRGAN_URL`, `_ESRGAN_SHA256`, `_ESRGAN_PATH` | pinned in `src/imagegen/config.py` | see docs/MODELS.md "How to swap" |
| `IMAGEGEN_LOG_LEVEL` | `INFO` | JSON lines on stdout; no prompts, tokens or image bytes |

Non-commercial repositories (FLUX.1 [dev], FLUX.2 [dev], FLUX.2 [klein] 9B, ...) are refused at start-up.

## Weights

```sh
./deploy/compose.sh exec imagegen python -m imagegen.download          # ~15.5 GB into the hf-models volume
./deploy/compose.sh exec imagegen python -m imagegen.download --check  # verify, no network
```

Then set `IMAGEGEN_HF_OFFLINE=1` in `.env`.

## Development

Tests use fake pipelines, so torch/diffusers are not needed:

```sh
cd apps/imagegen
uv venv .venv --python 3.12
uv pip install --python .venv fastapi uvicorn pillow numpy pydantic pytest httpx
.venv/bin/python -m pytest -q
```

`requirements.lock` pins every runtime package with hashes for the Docker image (regenerate with the command at its top
after changing `pyproject.toml`).
