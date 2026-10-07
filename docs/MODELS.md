# Models

Every model runs **locally** on `secforit-home` (NVIDIA RTX 3060 12 GB, Ampere sm_86, driver 595 / CUDA 13.2,
61 GiB RAM). Each one allows commercial use of the model and of what it produces, which the shop needs. Cloud fallbacks
(Anthropic for agents, Recraft for images) stay off unless configured; see "How to swap".

Checked on 2026-10-06 against the model cards, licence files and library sources linked below.

| Job | Model | Exact id (pinned) | Runtime | Licence | VRAM on the RTX 3060 | Download |
| --- | --- | --- | --- | --- | --- | --- |
| All seven agents: reasoning + JSON, plus the QA / compliance image look | Gemma 4 12B (QAT Q4) | Ollama `gemma4:12b` | `ollama` service, `/api/chat` | Apache 2.0 | ~8 GB at `num_ctx` 16384 | 7.7–8.0 GB |
| Raw art | FLUX.2 [klein] 4B | `black-forest-labs/FLUX.2-klein-4B` @ `e7b7dc27f91deacad38e78976d1f2b499d76a294` | `imagegen`, diffusers `Flux2KleinPipeline` | Apache 2.0 | ~9–11 GB peak with model CPU offload (~15 GB in bf16 without it) | 14.9 GiB |
| Transparent background | BiRefNet (general) | `ZhengPeng7/BiRefNet` @ `e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4` | `imagegen`, transformers `AutoModelForImageSegmentation` | MIT | ~2–3 GB (fp16, 1024×1024 input) | 424 MiB |
| Upscale to print size | Real-ESRGAN x4plus | `RealESRGAN_x4plus.pth` from the official v0.1.0 release, SHA-256 `4fa0d389…d682f1` | `imagegen`, `spandrel` 0.4.2 | BSD-3-Clause | ~1.5–2.5 GB (fp16, 512 px tiles) | 64 MiB |

VRAM figures for the image models are estimates from the weight sizes (transformer 7.22 GiB, Qwen3 text encoder
7.5 GiB, VAE 0.16 GiB in bf16) plus activations; check the real numbers with `nvidia-smi` during the first runs.

## One GPU, two owners

Ollama and the `imagegen` sidecar never hold VRAM at the same time. The worker wraps every GPU call in
`GpuCoordinator.withGpu(owner, fn)` (`packages/core/src/integrations/types.ts`): before image work it unloads Ollama's
models (`keep_alive: 0`), before LLM work it calls the sidecar's `POST /unload`, which drops FLUX, BiRefNet and
Real-ESRGAN and returns the cached VRAM with `torch.cuda.empty_cache()`. Ollama runs with `OLLAMA_MAX_LOADED_MODELS=1`
and `OLLAMA_NUM_PARALLEL=1`; the sidecar runs one GPU job at a time.

Peak usage therefore stays at whichever side is active: ~8 GB for gemma4:12b, ~9–11 GB for a FLUX generation. The
sidecar keeps a ~0.3–0.5 GB CUDA context after `/unload`; that fits next to gemma4:12b.

## Gemma 4 12B: `gemma4:12b` (Ollama)

- **Id:** `gemma4:12b` from the Ollama library (<https://ollama.com/library/gemma4>): text + image input, 256K max
  context; we request `num_ctx` 16384 (`OLLAMA_NUM_CTX`) to stay near 8 GB.
- **Licence:** Apache 2.0 (<https://ai.google.dev/gemma/docs/gemma_4_license>; model card
  <https://huggingface.co/google/gemma-4-12B-it>).
- **Why:** the largest Gemma 4 that fits the 3060 with room for a 16k context; follows a JSON schema through Ollama's
  `format`; has vision, so the QA mockup check and the final compliance image look use the same loaded model (no
  swap). The 26B/31B tags (16–20 GB) do not fit 12 GB.
- **Settings (agents builder, `llm/ollama.ts`):** `temperature` 0, `format` = JSON schema, thinking disabled, every
  output validated with zod and re-checked by code-side hard rules (a 12B local model is weaker against prompt
  injection; the code rules are what keep the shop safe).
- **Get it:** `./deploy/compose.sh --profile setup run --rm ollama-pull` (see `docs/RUNBOOK.md`).

## FLUX.2 [klein] 4B (`imagegen`)

- **Id:** `black-forest-labs/FLUX.2-klein-4B`, revision pinned to `e7b7dc27f91deacad38e78976d1f2b499d76a294`
  (<https://huggingface.co/black-forest-labs/FLUX.2-klein-4B>). Not gated.
- **Licence:** Apache 2.0 for the model and its outputs; commercial use allowed
  (<https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/blob/main/LICENSE.md>,
  <https://bfl.ai/blog/flux2-klein-towards-interactive-visual-intelligence>).
- **Code** (`apps/imagegen/src/imagegen/flux.py`, as on the model card and in diffusers 0.41.0):
  `Flux2KleinPipeline.from_pretrained(repo, revision=..., torch_dtype=torch.bfloat16)`,
  `pipe.enable_model_cpu_offload()`, then `pipe(prompt=..., height=..., width=..., num_inference_steps=4,
  guidance_scale=1.0, generator=torch.Generator("cuda").manual_seed(seed))`. Sizes are multiples of 16, 256–2048 px.
- **VRAM:** BFL quotes ~13 GB for the 4B model ("RTX 3090/4070 and above"), so it does not fit 12 GB in one piece.
  Model CPU offload moves one component at a time to the GPU (Qwen3 text encoder, then the 4B transformer, then the
  VAE) and keeps the rest in system RAM (~15 GB of the 61 GiB). The 3060 supports bf16.
- **Why:** the only current FLUX model with a commercial-use licence that runs on 12 GB; step-distilled to 4 steps, so
  a 1024×1024 image takes seconds even with offload; good prompt adherence and legible typography for print designs.
- **Text in images:** the Designer still asks for short text only; Razvan edits every design before it moves on.

## BiRefNet (`imagegen`)

- **Id:** `ZhengPeng7/BiRefNet`, revision pinned to `e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4`
  (<https://huggingface.co/ZhengPeng7/BiRefNet>, code <https://github.com/ZhengPeng7/BiRefNet>).
- **Licence:** MIT.
- **Code** (`birefnet.py`, as on the model card): `AutoModelForImageSegmentation.from_pretrained(repo,
  revision=..., trust_remote_code=True)`, `.to("cuda").eval().half()`, input resized to 1024×1024 and normalised with
  ImageNet mean/std, mask = `model(x)[-1].sigmoid()`, resized back to the art size.
- **Security:** `trust_remote_code` executes Python from the repository, which is why the revision is a fixed commit
  and never `main`. The pinned commit contains the transformers 5 fix (BiRefNet issue #285: `np.linspace` instead of
  `tensor.item()` during meta-device initialisation). Review `birefnet.py` before moving the pin.
- **Why:** state-of-the-art dichotomous segmentation with clean hair/edge detail, MIT licensed (unlike BRIA RMBG-2.0,
  see below), small enough to stay loaded next to FLUX's offloaded components.
- **Post-processing:** alpha values ≤ 8 become 0 and ≥ 247 become 255 (fewer semi-transparent pixels on prints), then
  the white halo is removed from edge colours with the blur-fusion foreground estimator that BiRefNet's reference
  handler uses. FLUX is told to draw the subject on plain white, which makes the cut-out reliable; white artwork on
  white will matte poorly, so the Designer should avoid all-white subjects for transparent products.

## Real-ESRGAN x4plus (`imagegen`)

- **Id:** `RealESRGAN_x4plus.pth` from the official release
  <https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth>, SHA-256
  `4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1` (checked before every load). Stored at
  `/models/realesrgan/RealESRGAN_x4plus.pth` on the `hf-models` volume.
- **Licence:** BSD-3-Clause (<https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE>). Loader: spandrel, MIT
  (<https://github.com/chaiNNer-org/spandrel>).
- **Code** (`esrgan.py`): `spandrel.ModelLoader().load_from_file(path)` → `ImageModelDescriptor` (scale 4, 3 channels,
  fp16 on CUDA), run in 512 px tiles with 16 px of context per side; the tile size halves automatically on CUDA OOM.
  `factor=2` = x4 then an antialiased bicubic ×0.5 per tile on the GPU. Alpha goes through the model as a grey image
  (same approach as Real-ESRGAN's reference inference). Output is capped at 12000 px per side.
- **Why:** robust general-purpose x4 upscaler for illustrations and photos, permissive licence, tiny (64 MiB), and
  spandrel loads it with a restricted unpickler.

## Do NOT use

| Model | Why not |
| --- | --- |
| FLUX.1 [dev] (`black-forest-labs/FLUX.1-dev`) and its Kontext/Krea/Fill/Canny/Depth/Redux "dev" variants | FLUX.1 [dev] Non-Commercial License (<https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md>) |
| FLUX.2 [klein] 9B and FLUX.2 [klein] base 9B | FLUX Non-Commercial License (BFL's klein announcement); 4B is the Apache 2.0 one |
| FLUX.2 [dev] | FLUX Non-Commercial License; also far too large for 12 GB |
| BRIA RMBG-2.0 (`briaai/RMBG-2.0`) | CC BY-NC 4.0 unless you buy a commercial agreement |
| 4x-UltraSharp (`Kim2091/UltraSharp`) and other community upscalers | many are CC BY-NC(-SA); check before swapping |

The sidecar refuses to start if `IMAGEGEN_FLUX_REPO` or `IMAGEGEN_BIREFNET_REPO` names one of the black-forest-labs
non-commercial repositories above (`NON_COMMERCIAL_REPOS` in `apps/imagegen/src/imagegen/config.py`).

## Downloads and offline mode

```sh
./deploy/compose.sh --profile setup run --rm ollama-pull                    # gemma4:12b, ~8 GB
./deploy/compose.sh exec imagegen python -m imagegen.download           # FLUX + BiRefNet + Real-ESRGAN, ~15.5 GB
./deploy/compose.sh exec imagegen python -m imagegen.download --check   # verify without network
```

`imagegen.download` fetches exactly the pinned revisions the server loads (FLUX via `Flux2KleinPipeline.download`, so
the duplicate single-file checkpoint at the repo root is skipped). Afterwards set `IMAGEGEN_HF_OFFLINE=1` in `.env`:
the sidecar then never contacts huggingface.co or GitHub, and a missing file is reported as 503 `model_unavailable`
instead of being downloaded.

## Software versions

`apps/imagegen/requirements.lock` pins every package with hashes. Key ones: Python 3.12, torch 2.14.1 (CUDA 13.0 build,
kernels for sm_75/80/86/90; runs on the host's CUDA 13.2 driver), torchvision 0.29.1, diffusers 0.41.0 (has
`Flux2KleinPipeline`), transformers 5.19.0, accelerate 1.15.0, huggingface-hub 1.33.0 (diffusers needs < 2.0),
spandrel 0.4.2, timm 1.0.30, kornia 0.8.3, einops 0.8.2 (the last three are imported by BiRefNet's code). Base image:
`nvidia/cuda:13.0.3-runtime-ubuntu24.04` (pinned by digest in `apps/imagegen/Dockerfile`).

## How to swap

Always check the licence first (model and outputs, commercial use), then the VRAM budget (≤ 12 GB with Ollama
unloaded), then run the pipeline in mock mode and on one real product before going live.

- **LLM (per size class):** set `OLLAMA_MODEL_LARGE`, `OLLAMA_MODEL_SMALL`, `OLLAMA_MODEL_VISION` in `.env` and pull
  the tag (`./deploy/compose.sh exec ollama ollama pull <tag>`). Keep the vision model able to read images. A different
  context size: `OLLAMA_NUM_CTX` (VRAM grows with it).
- **Cloud LLM for some agents:** `LLM_ROUTES={"compliance_guard":"anthropic"}` plus `ANTHROPIC_API_KEY`,
  `ANTHROPIC_MODEL_LARGE`, `ANTHROPIC_MODEL_SMALL` (counts against the $10/day cloud cap).
- **Image generator:** `IMAGEGEN_FLUX_REPO` + `IMAGEGEN_FLUX_REVISION` (a full commit sha). The code uses
  `Flux2KleinPipeline`, so only FLUX.2 klein-family checkpoints load (for example the undistilled
  `black-forest-labs/FLUX.2-klein-base-4B`, also Apache 2.0, which needs more steps: change `flux_steps` and
  `flux_guidance` in `config.py`). Any other architecture needs a new `Generator` implementation in
  `apps/imagegen/src/imagegen/` behind the same interface (`interfaces.py`) and a factory in `real.py`.
- **Cloud images:** `IMAGEGEN_PROVIDER=recraft` + `RECRAFT_API_KEY` (no sidecar needed; costs per image).
- **Matting:** `IMAGEGEN_BIREFNET_REPO` + `IMAGEGEN_BIREFNET_REVISION` (another BiRefNet variant from the same author,
  for example a lite or HR checkpoint; review the remote code at that commit first).
- **Upscaler:** `IMAGEGEN_ESRGAN_URL` (https) + `IMAGEGEN_ESRGAN_SHA256` (+ optionally `IMAGEGEN_ESRGAN_PATH`). Any
  3-channel x4 model that spandrel recognises works; the sidecar rejects other scales.
- After any swap: `python -m imagegen.download`, restart the service, and run
  `./deploy/compose.sh run --rm worker check-gpu`.
