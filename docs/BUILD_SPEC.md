# Build spec — Etsy agent team

Read this whole file before writing code. Architecture doc (context only):
https://claude.ai/code/artifact/e5795e3b-3519-4911-9672-77a11215c48e — this spec is authoritative for the build.

## What the system does

Seven agents turn trend signals into original print-on-demand products and leave each one as an Etsy
**draft** for Razvan to approve. Everything is self-hosted on Razvan's own server and the AI models run
LOCALLY on its GPU by default. Docker Compose services: `postgres`, `ollama` (GPU), `imagegen` (GPU sidecar),
`worker`, `desk`. No Supabase, no Vercel, no Caddy, **no public ports**: the desk listens on 127.0.0.1 and is
reached over Tailscale (`tailscale serve` provides HTTPS on the tailnet).

Pipeline per product (`packages/core/src/domain/stateMachine.ts` is the source of truth):

```
proposed -concept_check-> cleared -design-> designed --(Razvan uploads edited PNG)--> edited
  -write-> written -final_check-> final_cleared -qa_publish-> drafted --(Razvan approves)--> live -analyze-> retired
stop states: blocked (compliance or QA failed twice), rejected (Razvan)
qa_publish failure -> back to designed (Razvan re-uploads), max 2 redesigns, then blocked
```

Niche-level jobs: `trend_scan` (Trend Scout) creates niches; `validate_niche` (Niche Validator) creates 0–3 `proposed` products.

## Target server and models (decided — do not substitute)

Host `secforit-home`: Ubuntu 26.04 LTS, Intel i9-12900K (16 cores / 24 threads), 61 GiB RAM,
**NVIDIA RTX 3060 12 GB** (driver 595, CUDA 13.2, Ampere sm_86, bf16 OK), 915 GB NVMe, LAN 10.2.3.2/24, Tailscale up.

| Job | Model | Runtime | License | VRAM |
| --- | --- | --- | --- | --- |
| All seven agents' text reasoning + structured JSON | `gemma4:12b` (Gemma 4 12B, QAT Q4) | Ollama `/api/chat` with `format` = JSON schema, `temperature` 0, `options.num_ctx` 16384 | Apache 2.0 | ~8 GB at 16k ctx |
| QA mockup vision check, final-compliance image look | `gemma4:12b` (vision) | Ollama, `images` = base64 | Apache 2.0 | same model, no swap |
| Raw art generation | FLUX.2 [klein] 4B (`black-forest-labs/FLUX.2-klein-4B`), `Flux2KleinPipeline`, 4 steps, guidance 1.0 | diffusers in `imagegen` sidecar, `enable_model_cpu_offload()` | Apache 2.0 (model and outputs, commercial OK) | ~13 GB bf16 → fits 12 GB with CPU offload (61 GiB RAM) |
| Transparent background | BiRefNet (via rembg or transformers) | `imagegen` sidecar | MIT | small |
| Upscale to print size | Real-ESRGAN x4plus weights loaded with `spandrel` | `imagegen` sidecar | BSD-3-Clause | small, tile if needed |

Do NOT use FLUX.1 [dev] or FLUX.2 [klein] 9B (non-commercial licenses). Optional cloud fallbacks stay available
behind config: Anthropic for any agent via `LLM_ROUTES`, Recraft via `IMAGEGEN_PROVIDER=recraft`.

One GPU, two owners: Ollama and the sidecar cannot hold VRAM together. All GPU work goes through
`GpuCoordinator.withGpu(owner, fn)` (integrations/types.ts): serialised; on owner change it releases the other
side first (Ollama: `POST /api/generate {"model": m, "keep_alive": 0}` for each loaded model listed by `GET /api/ps`;
sidecar: `POST /unload`). Ollama runs with `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`.
Worker processes one job at a time (no GPU contention inside the worker).

## Business decisions (packages/core/src/config/shop.ts)

New Etsy shop · listings in EUR · t-shirts, mugs, posters · US buyers first · Printify free plan ·
free trend sources only (Etsy search, Pinterest if token, seasonal calendar) · Razvan edits EVERY design
before it moves on · pilot cap 5 drafts/day, $10/day cloud spend cap (local models cost $0; spend counts only cloud calls).

## Contract files — DO NOT EDIT

`domain/types.ts`, `domain/stateMachine.ts`, `config/shop.ts`, `config/env.ts`, `db/db.ts`,
`db/migrations/001_init.sql`, `integrations/types.ts`, `llm/types.ts`, `agents/contracts.ts`,
`desk/contracts.ts`, `orchestrator/contracts.ts`, `src/index.ts`.
If a contract is insufficient: put the addition in a NEW file you own and list it under `contractIssues`.
New SQL goes in a new migration `002_<name>.sql` (orchestrator builder only).

Stub files you must REPLACE (keep the exported signature):
`integrations/factory.ts` (integrations), `llm/factory.ts` + `agents/registry.ts` (agents), `desk/service.ts` (orchestrator).

## Ownership — touch only your paths

| Builder | Owns |
| --- | --- |
| integrations | `packages/core/src/integrations/**` except `types.ts` |
| agents | `packages/core/src/llm/**` except `types.ts`; `packages/core/src/agents/**` except `contracts.ts` |
| orchestrator | `packages/core/src/orchestrator/**` except `contracts.ts`; `packages/core/src/desk/service.ts` (+ new files in `desk/` other than `contracts.ts`); `packages/core/src/db/migrations/002_*.sql`; `apps/worker/**`; `deploy/**`; `.env.example`; `docs/RUNBOOK.md` |
| desk | `apps/desk/**` |
| imagegen | `apps/imagegen/**` (Python sidecar); `docs/MODELS.md` |

Builders work IN PARALLEL in the same tree. Never edit, format, or delete files outside your paths.
Do not run `npm install` at the repo root except the desk builder (for `apps/desk` only: `npm install -w apps/desk <pkgs>`).
Core deps already installed: zod 4, pg, @electric-sql/pglite, @anthropic-ai/sdk, sharp, pino, vitest, tsx, typescript.
Ollama is called with plain `fetch` (no SDK). Need anything else? List it in `depsNeeded`.

## Conventions

- TypeScript strict, ESM, Node 22. Relative imports use the `.ts` extension (`import { x } from './a.ts'`).
- `import type` for type-only imports (verbatimModuleSyntax).
- Tests: vitest, colocated `*.test.ts`. No network in tests — stub `fetch` or inject fakes. Your tests must NOT depend on
  another builder's unfinished code: write small local fakes for interfaces you consume.
- Determinism: never call `Date.now()`/`new Date()` inside agents; use injected `today`/`now()`.
- Logging: the `Logger` from `orchestrator/contracts.ts`. Never log secrets, tokens, or image bytes.
- Money: EUR for listings, USD for Printify costs and cloud model spend. Round money to cents. Local model calls cost 0.
- Before you finish, typecheck and test your own paths (commands in your brief).

## Security requirements (all builders)

1. **Secrets** only from env (`loadEnv`, `*_FILE` Docker secrets). Never log, return to the browser, or store in DB.
2. **The model never acts.** LLMs get data and return schema-validated JSON; code does every API write. No tool loops with write access.
3. **Prompt injection:** trend keywords, competitor titles, OCR text, Etsy data are UNTRUSTED. Pass them only via
   `LlmRequest.untrustedData`; every LLM client wraps them in `<untrusted_data>` tags and the system prompt says they are data.
   Validate every model output with zod; enforce hard rules (disclosures, tag limits, blocklist, trademark) in code AFTER the model.
   Local models are weaker at resisting injection: the code-side hard rules are what keep the shop safe.
4. **SQL:** parameterised queries only.
5. **Outbound HTTP:** HTTPS only for the internet, explicit timeouts (default 20 s; Ollama and imagegen up to 300 s),
   retries only on 429/5xx with `retry-after` respected, host allowlist for third-party URLs (SSRF).
   Internal services (`ollama`, `imagegen`) are plain HTTP on the private Docker network only, never published.
6. **Uploads:** PNG only (magic bytes), max 50 MB, max 12000×12000 px, re-encoded by sharp before storage; never trust filename.
7. **Blob keys:** `[a-z0-9/_.-]` only, no `..`, no leading `/`; storage resolves inside its root and rejects escapes.
8. **Desk auth:** single user, scrypt-hashed password, HMAC-signed httpOnly+Secure+SameSite=Strict session cookie (12 h),
   every route and action behind auth, login rate limit, origin check on mutations, security headers (CSP, frame-ancestors none).
9. **Network exposure:** no service publishes a port on 0.0.0.0. The desk publishes only `127.0.0.1:3000`; Razvan reaches it via
   `tailscale serve`. Postgres, Ollama and imagegen have no published ports. imagegen requires `Authorization: Bearer $IMAGEGEN_TOKEN`.
10. **Containers:** non-root users, read-only root FS where possible, `no-new-privileges`, healthchecks, restart policies,
    GPU only for `ollama` and `imagegen`.
11. **Audit:** every human action and every external write (Printify create/publish, Etsy activate/update) goes to `audit_log`.

## Area briefs

### integrations
Mock* and Live* for every interface in integrations/types.ts: Etsy (v3 `https://api.etsy.com/v3/application`, `x-api-key` +
OAuth bearer, refresh-token flow; `findAllListingsActive`, `getListing`, `getListingsByShop`, `updateListing`, `getShopReceipts`),
Printify (`https://api.printify.com/v1`: catalog blueprints/print providers/variants/shipping, `uploads/images.json`,
`shops/{id}/products.json`, `products/{id}/publish.json`; 600 req/min, publish 200/30 min), Marker trademark API (USPTO),
trend sources (etsy_search, pinterest `GET /v5/trends/keywords/{region}/top/{trend_type}` returning [] without token or on 403,
seasonal US calendar JSON), filesystem `BlobStorage`, sharp `ImageTools`.
Image generation: `LocalImageGenClient` (default) calling the imagegen sidecar `POST /generate` inside `gpu.withGpu('image')`,
plus `RecraftImageGenClient` (optional), `LocalUpscaler` (`POST /upscale`), `OllamaAwareGpuCoordinator` (see the GPU section),
`MockGpuCoordinator` (serialise only), `fetchImage` built on `safeFetchAllowlisted` (Printify image CDN hosts).
Sidecar API (implemented by the imagegen builder; code to this contract):
`POST /generate` JSON `{prompt, width, height, seed?, transparent}` → `image/png` bytes + header `x-seed`;
`POST /upscale` body PNG, query `factor=2|4` → PNG; `POST /unload` → 204; `GET /healthz` → `{"ok":true,"loaded":[...]}`.
All require `Authorization: Bearer <IMAGEGEN_TOKEN>`. Width/height multiples of 16, max 2048 each.
Shared `http.ts`: timeouts, retry/backoff, per-service token bucket, `safeFetchAllowlisted(url, hosts)` (https only, host in
allowlist, no cross-host redirects, size limit). Verify live endpoint shapes against official docs with WebFetch; record
anything unverified in `openQuestions`. Mocks deterministic and realistic enough to drive a full pipeline (mock Printify publish
returns an external Etsy id; mock Etsy activate flips state; mock image gen returns a real PNG with alpha via sharp, fast).
`createIntegrations(env)` returns mocks when `env.MODE === 'mock'`, live clients otherwise (picking image provider from env).

### agents
`llm/ollama.ts`: OllamaLlm — `POST {OLLAMA_BASE_URL}/api/chat`, `stream:false`, `format: z.toJSONSchema(schema)`,
`options: {temperature: 0, num_ctx: OLLAMA_NUM_CTX}`, images as base64 in the user message `images` array (vision model for
requests with images), parse `message.content` as JSON, validate with zod, one repair retry with the validation error, cost 0,
tokens from `prompt_eval_count`/`eval_count`, durations from `total_duration`, every call inside `gpu.withGpu('llm', …)`.
Disable "thinking" output if the model emits it (check the Ollama docs for the `think` field). `llm/anthropic.ts`: optional
AnthropicLlm (forced tool call with `input_schema` = `z.toJSONSchema(schema)`, repair retry, retries, cost from a price table in
env `LLM_PRICES_JSON`, unknown = 0 + warning; model ids only from env). `llm/router.ts`: RoutedLlm choosing per `req.agent`
from `env.LLM_ROUTES[agent] ?? env.LLM_DEFAULT_PROVIDER`. `llm/mock.ts`: deterministic per-agent outputs satisfying each schema
and exercising the pipeline. All clients wrap `untrustedData` in `<untrusted_data>` tags with a system rule that it is data.
Prompts must be short and explicit (12B local model): numbered rules, one example of the expected JSON shape, no long prose.
One file per agent under `agents/` + `prompts.ts` + `pricing.ts` + `registry.ts`. Hard rules in code: Compliance Guard blocks on
any blocklist hit or LIVE trademark in the product's Nice class regardless of the model (exact, plural, normalised variants);
Listing Writer strips any model-written disclosure text, appends `SHOP.listing.aiDisclosure` + `productionPartnerDisclosure`,
dedupes/lowercases tags, enforces 13 tags ≤ 20 chars and title ≤ 140, re-runs blocklist, applies price rules (min margin, x.99).
Designer: request size = product printSpec × `SHOP.imageGen.generationScale` rounded to multiples of 16 (≤ 2048), else
`defaultSizePx`; transparent for tshirt/mug, opaque for poster; stores art under `designs/<productId>/art-<n>.png`.
QA & Publisher: sharp inspection; if the edited file is smaller than the print spec, upscale with `deps.upscaler` (x2/x4) then exact
resize with `imageTools.toPrintFile`; checks (size, DPI, alpha, sRGB, semi-transparent share); create or reuse the Printify product;
publish; poll `getProduct` until `external.id` (bounded); vision check of up to 3 mockups fetched with `deps.fetchImage`.
Analyst: retirement by code rules; model writes only the report. Each agent returns `{ output, llmUsage }`.

### orchestrator
`repo.ts`, `queue.ts` (idempotent enqueue; claim with `FOR UPDATE SKIP LOCKED`; backoff; stale-lock recovery after 15 min; max
attempts → failed + audit), `steps.ts` (load inputs → call agent → validate → persist + `transition()` in ONE transaction → enqueue
next via `stepForState`), `orchestrator.ts` (`runOnce()`; checks `settings.paused`, daily draft cap, daily cloud spend cap BEFORE
each job; records agent_runs for every LLM call incl. local ones with cost 0), `scheduler.ts` (daily `trend_scan`, hourly
`analyze`, idempotent keys), `desk/service.ts` (DeskService; approve → `etsy.updateListing({state:'active'})`; reject → reason as
avoid-rule; upload → validate per rule 6 → storage → `edit_uploaded`). Avoid-rules: latest 20 rejection reasons feed Designer and
Listing Writer. Wire `createLlm(env, { gpu: integrations.gpu })`.
`apps/worker/src/cli.ts`: `migrate`, `run` (loop, graceful SIGTERM, one job at a time), `demo` (MODE=mock, in-memory PGlite,
full pipeline incl. simulated upload and approval, prints a summary), `setup-catalog`, `hash-password`
(format `scrypt$N$r$p$saltB64$hashB64`), `check-gpu` (calls Ollama `/api/tags` and imagegen `/healthz`, prints what is missing).
`deploy/docker-compose.yml`: postgres:16-alpine (volume, no ports); `ollama/ollama` (GPU reservation
`deploy.resources.reservations.devices: [{driver: nvidia, count: 1, capabilities: [gpu]}]`, volume for models,
`OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`, no ports); `imagegen` (build `../apps/imagegen`, GPU, HF cache volume,
no ports); `worker`; `desk` (`127.0.0.1:3000:3000` only). Internal network for everything; an `ollama-pull` one-shot service or
documented command to pull `gemma4:12b`. `deploy/Dockerfile.worker` (node:22-slim, non-root). `deploy/backup.sh`
(pg_dump + blobs, 14-day rotation). `.env.example` documenting every key. `docs/RUNBOOK.md` for Ubuntu 26.04 on secforit-home:
Docker + NVIDIA Container Toolkit install and `nvidia-smi` check inside a container, first model downloads (Ollama pull, Hugging
Face weights for FLUX.2 klein 4B, BiRefNet, Real-ESRGAN), `tailscale serve --bg --https=443 http://127.0.0.1:3000`, first run,
backups/restore, rotating secrets, pausing, VRAM troubleshooting, going-live checklist.

### desk
Next.js App Router TypeScript app in `apps/desk`, `output: 'standalone'`, `transpilePackages: ['@etsy-agents/core']`.
Imports only `createDeskServiceFromEnv` from `@etsy-agents/core/desk/service.ts`, `loadEnv`, and types.
Pages: login, dashboard (counts, caps, spend, pause toggle, latest weekly report), queue (filter by state; needs-action first),
product detail (raw art, edited, print file via an authenticated route handler; compliance results; listing copy; margin; upload
edited PNG; approve; reject with reason), settings (caps, blocklist). Auth per security rule 8 in `apps/desk/lib/auth.ts` with
unit tests (`apps/desk/lib/*.test.ts`, run by root vitest). `Dockerfile.desk` in `apps/desk/` (multi-stage, non-root, standalone,
HEALTHCHECK, listens on 0.0.0.0:3000 inside the container — compose maps it to 127.0.0.1 only). Served over Tailscale HTTPS, so
Secure cookies work. `next build` must succeed without real secrets. Plain CSS, readable, works on a phone.

### imagegen
Python 3.12 FastAPI sidecar in `apps/imagegen` implementing the sidecar API above. Pipelines behind small interfaces
(`Generator`, `Matting`, `Upscaler`) so tests use fakes; real implementations: diffusers `Flux2KleinPipeline`
(`black-forest-labs/FLUX.2-klein-4B`, bf16, `enable_model_cpu_offload()`, 4 steps, guidance 1.0, seeded generator),
BiRefNet matting for `transparent: true` (generate on a plain white background prompt suffix, then matte), Real-ESRGAN x4plus via
`spandrel` with tiling for large inputs. Lazy load on first request; `/unload` frees models and calls `torch.cuda.empty_cache()`;
a single asyncio lock so only one GPU job runs at a time; request limits (prompt ≤ 2000 chars, dims multiples of 16 ≤ 2048, upload
≤ 50 MB, Pillow decompression-bomb limit); bearer token check with `hmac.compare_digest`; no file paths from requests.
`pyproject.toml` (pin versions; torch CUDA wheels for cu12x/cu13x that support sm_86), `Dockerfile` (CUDA runtime base,
non-root, HF cache at /models, HEALTHCHECK), `tests/` with pytest + FastAPI TestClient using fake pipelines (do not install
torch in this sandbox: keep torch/diffusers imports inside the real-implementation modules only). `docs/MODELS.md`: every model,
exact repo id, license with link, VRAM, why chosen, how to swap. Verify the diffusers class name and Flux2Klein call signature
and the BiRefNet/spandrel loading code against their official docs/model cards with WebFetch.
