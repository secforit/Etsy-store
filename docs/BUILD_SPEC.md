# Build spec — Etsy agent team

Read this whole file before writing code. The architecture doc this implements:
https://claude.ai/code/artifact/e5795e3b-3519-4911-9672-77a11215c48e (summary below is authoritative for the build).

## What the system does

Seven agents turn trend signals into original print-on-demand products and leave each one as an Etsy
**draft** for Razvan to approve. Self-hosted on Razvan's own server with Docker Compose (Postgres,
worker, approval desk, Caddy). No Supabase, no Vercel.

Pipeline per product (`packages/core/src/domain/stateMachine.ts` is the source of truth):

```
proposed -concept_check-> cleared -design-> designed --(Razvan uploads edited PNG)--> edited
  -write-> written -final_check-> final_cleared -qa_publish-> drafted --(Razvan approves)--> live -analyze-> retired
stop states: blocked (compliance or QA failed twice), rejected (Razvan)
qa_publish failure -> back to designed (Razvan re-uploads), max 2 redesigns, then blocked
```

Niche-level jobs: `trend_scan` (Trend Scout) creates niches; `validate_niche` (Niche Validator) creates 0–3 `proposed` products.

## Business decisions (packages/core/src/config/shop.ts)

New Etsy shop · listings in EUR · t-shirts, mugs, posters · US buyers first · Printify free plan ·
free trend sources only (Etsy search, Pinterest if token, seasonal calendar) · Razvan edits EVERY design
before it moves on · pilot cap 5 drafts/day, $10/day model spend.

## Contract files — DO NOT EDIT

`domain/types.ts`, `domain/stateMachine.ts`, `config/shop.ts`, `config/env.ts`, `db/db.ts`,
`db/migrations/001_init.sql`, `integrations/types.ts`, `llm/types.ts`, `agents/contracts.ts`,
`desk/contracts.ts`, `orchestrator/contracts.ts`, `src/index.ts`.
If a contract is insufficient: put the addition in a NEW file you own, and list it under
`contractIssues` in your report. New SQL goes in a new migration `002_<owner>_*.sql` (orchestrator builder only).

Stub files you must REPLACE (keep the exported signature):
`integrations/factory.ts` (integrations builder), `llm/factory.ts` + `agents/registry.ts` (agents builder),
`desk/service.ts` (orchestrator builder).

## Ownership — touch only your paths

| Builder | Owns |
| --- | --- |
| integrations | `packages/core/src/integrations/**` except `types.ts` |
| agents | `packages/core/src/llm/**` except `types.ts`; `packages/core/src/agents/**` except `contracts.ts` |
| orchestrator | `packages/core/src/orchestrator/**` except `contracts.ts`; `packages/core/src/desk/service.ts` (+ new files in `desk/` other than `contracts.ts`); `packages/core/src/db/migrations/002_*.sql`; `apps/worker/**`; `deploy/**`; `.env.example`; `docs/RUNBOOK.md` |
| desk | `apps/desk/**` |

Other builders work IN PARALLEL in the same tree. Never edit, format, or delete files outside your paths.
Do not run `npm install` at the repo root except the desk builder (for `apps/desk` deps only:
`npm install -w apps/desk <pkgs>`). Core deps already installed: zod 4, pg, @electric-sql/pglite,
@anthropic-ai/sdk, sharp, pino, vitest, tsx, typescript. Need anything else? List it in `depsNeeded`.

## Conventions

- TypeScript strict, ESM, Node 22. Relative imports use the `.ts` extension (`import { x } from './a.ts'`).
- `import type` for type-only imports (verbatimModuleSyntax).
- Tests: vitest, colocated `*.test.ts`. No network in tests — stub `fetch` or inject fakes.
  Because builders run in parallel, your tests must NOT depend on another builder's unfinished code:
  write small local fakes for interfaces you consume (e.g. a fake `LlmClient` or `EtsyClient` inside your test file).
- Determinism: never call `Date.now()`/`new Date()` inside agents; use injected `today`/`now()`.
- Logging: pino-compatible `Logger` from `orchestrator/contracts.ts`. Never log secrets, tokens, full prompts with keys, or image bytes.
- Money: EUR for listings, USD for Printify costs and model spend. Round money to cents.
- Before you finish: `npx tsc -p packages/core/tsconfig.json --noEmit` (and `apps/worker` / `apps/desk` as relevant) and
  `npx vitest run <your paths>` must pass. Run tests only for your own paths.

## Security requirements (all builders)

1. **Secrets** only from env (`loadEnv`, `*_FILE` Docker secrets). Never log, return to the browser, or store in DB.
2. **The model never acts.** LLMs get data and return schema-validated JSON; code does every API write. No tool loops with write access.
3. **Prompt injection:** trend keywords, competitor titles, OCR text, Etsy data are UNTRUSTED. Pass them only via
   `LlmRequest.untrustedData`; the LLM client wraps them in `<untrusted_data>` tags and the system prompt says they are data.
   Validate every model output with zod; enforce hard rules (disclosures, tag limits, blocklist, trademark) in code AFTER the model.
4. **SQL:** parameterised queries only. No string-built SQL with values.
5. **Outbound HTTP:** HTTPS only, explicit timeouts (default 20 s), retries only on 429/5xx with `retry-after` respected,
   and a host allowlist for any URL that comes from a third party (e.g. Printify mockup URLs) to prevent SSRF.
6. **Uploads:** PNG only (magic bytes), max 50 MB, max 12000×12000 px, re-encoded by sharp before storage; never trust filename.
7. **Blob keys:** `[a-z0-9/_.-]` only, no `..`, no leading `/`; storage resolves inside its root and rejects escapes.
8. **Desk auth:** single user, scrypt-hashed password, HMAC-signed httpOnly+Secure+SameSite=Strict session cookie (12 h),
   every route and action behind auth, login rate limit, origin check on mutations, security headers (CSP, frame-ancestors none).
9. **Containers:** non-root users, read-only root FS where possible, Postgres not published to the host, only Caddy exposes 80/443.
10. **Audit:** every human action and every external write (Printify create/publish, Etsy activate/update) goes to `audit_log`.

## Area briefs

### integrations
Mock* and Live* for: Etsy (v3: `https://api.etsy.com/v3/application`, headers `x-api-key` + OAuth bearer; refresh token
flow for access tokens; `findAllListingsActive`, `getListing`, `getListingsByShop`, `updateListing`, `getShopReceipts`),
Printify (`https://api.printify.com/v1`: catalog blueprints/print providers/variants/shipping, `uploads/images.json`,
`shops/{id}/products.json`, `products/{id}/publish.json`; 600 req/min, publish 200/30 min), Marker trademark API (USPTO),
Recraft image generation (transparent PNG) with Ideogram optional, trend sources (Etsy search, Pinterest
`GET /v5/trends/keywords/{region}/top/{trend_type}` — returns [] when no token or 403, seasonal calendar JSON for US),
filesystem `BlobStorage`, sharp-based `ImageTools`. Verify endpoint paths and payload shapes against the official docs
(WebFetch) before writing Live clients; note anything you could not verify in `openQuestions`.
Shared `http.ts`: timeouts, retry/backoff, rate-limit token bucket per service, allowlisted-host fetch.
Mocks must be deterministic and realistic enough to drive a full pipeline (mock Printify publish returns an external Etsy id;
mock Etsy activate flips state; mock image gen returns a real PNG of the requested size with alpha via sharp).
`createIntegrations(env)` returns mocks when `env.MODE === 'mock'`, live clients otherwise.

### agents
`llm/anthropic.ts` (Messages API, forced tool call whose `input_schema` is `z.toJSONSchema(schema)`, validate with zod,
1 repair retry on invalid output, retry 429/5xx/overloaded with backoff, cost from a per-model price table in env or
config — unknown price = 0 with a warning, model ids from env), `llm/mock.ts` (deterministic outputs per agent that satisfy
each schema and exercise the pipeline), `llm/factory.ts`. One file per agent under `agents/`, plus `agents/registry.ts`.
Hard rules in code: Compliance Guard blocks on any blocklist hit or LIVE trademark in the product's Nice class regardless
of the model; checks exact, plural and normalised (case, punctuation, spacing) variants. Listing Writer: code strips any
model-written disclosure text, appends `SHOP.listing.aiDisclosure` and `productionPartnerDisclosure`, dedupes/lowercases
tags, enforces 13 tags ≤ 20 chars and title ≤ 140, re-runs blocklist on title/tags, applies price rules (min margin,
x.99). QA & Publisher: sharp inspection (size, DPI, alpha, sRGB, semi-transparent share), builds print file, creates or
reuses the Printify product, publishes, polls `getProduct` until `external.id` appears (bounded), vision check of up to
3 mockups (fetched via the allowlisted fetcher from integrations — receive it via deps; if unavailable, skip with a note).
Analyst: retirement decided by code rules; the model only writes the report. Each agent returns `{ output, llmUsage }`.

### orchestrator
`repo.ts` (typed queries for every table), `queue.ts` (enqueue with idempotency key; claim with
`FOR UPDATE SKIP LOCKED`; backoff; stale-lock recovery after 15 min; max attempts → failed + audit),
`steps.ts` (one handler per JobKind: load inputs → call agent → validate → persist + state transition in ONE transaction →
enqueue next step via `stepForState`), `orchestrator.ts` (`runOnce()` claims and runs up to N jobs; checks `settings.paused`,
daily draft cap (counts products entering `drafted` today) and daily spend cap (sum agent_runs.cost_usd today) BEFORE each
job; records agent_runs for every LLM call), `scheduler.ts` (daily `trend_scan`, hourly `analyze`, as idempotent jobs keyed
by date/hour), `desk/service.ts` (DeskService over repo + integrations; approve → `etsy.updateListing(state active)`;
reject → reason saved as avoid-rule; upload → validate per security rule 6 → storage → `edit_uploaded`).
Avoid-rules: store rejection reasons and feed the latest 20 into Designer and Listing Writer inputs.
`apps/worker/src/cli.ts`: `migrate`, `run` (loop with graceful SIGTERM), `demo` (MODE=mock, in-memory PGlite: seeds,
runs trend_scan → … → designed, simulates Razvan's upload, continues to drafted, simulates approval → live, runs analyze;
prints a summary), `setup-catalog` (reads Printify catalog ids into a JSON file), `hash-password` (prints scrypt hash).
`deploy/`: `docker-compose.yml` (postgres:16-alpine with volume, no published port; worker; desk; caddy with automatic TLS
for `DESK_DOMAIN`), `Dockerfile.worker` (non-root, node:22-slim), `Caddyfile`, `backup.sh` (pg_dump + blobs, 14-day rotation).
`.env.example` documenting every key (no real values). `docs/RUNBOOK.md`: setup on Razvan's server, first run, backups, restore,
rotating secrets, pausing, going live checklist.

### desk
Next.js (App Router, TypeScript) in `apps/desk`, `output: 'standalone'`, `transpilePackages: ['@etsy-agents/core']`.
Imports only `createDeskServiceFromEnv` from `@etsy-agents/core/desk/service.ts`, `loadEnv` from config, and types.
Pages: login, dashboard (counts, caps, spend, pause toggle, latest weekly report), queue (filter by state; "needs action"
first), product detail (raw art, edited, print file via an authenticated route handler; compliance results; listing copy;
margin; upload edited PNG; approve; reject with reason), settings (caps, blocklist). Auth per security rule 8 in
`apps/desk/lib/auth.ts` with unit tests (`apps/desk/lib/*.test.ts` run by root vitest). `Dockerfile.desk` in `apps/desk/`
(multi-stage, non-root, standalone output). `next build` must succeed. Plain CSS, clean and readable, works on a phone.
