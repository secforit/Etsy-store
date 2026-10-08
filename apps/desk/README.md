# Approval desk (`@etsy-agents/desk`)

Next.js 16 App Router app where Razvan uploads his edited designs and approves or rejects Etsy drafts.
It talks only to `createDeskServiceFromEnv(loadEnv())` from `@etsy-agents/core`; it never touches the
database or external APIs directly.

## Pages

| Path | What |
| --- | --- |
| `/login` | Password sign-in (rate limited: 5 attempts per IP per 15 min) |
| `/` | Dashboard: counts by state, drafts and cloud spend against today's caps, pause/resume, latest weekly report |
| `/queue` | Products filtered by state, the ones waiting on you first |
| `/products/<id>` | Raw art, edited file, print file, compliance results, listing copy, margin; upload, approve, reject (optionally marked as an IP miss) |
| `/rollout` | Rollout gates 2 and 3 (drafts reviewed, approval rate, IP misses, first sales, cost per listing, margin), the numbers behind them, block rate by trend source |
| `/settings` | Daily draft cap, daily cloud spend cap, blocklist, pause |
| `/products/<id>/asset/<art\|edited\|print>` | Authenticated image download (`private, no-store`) |
| `/healthz` | Liveness for the container healthcheck (no data) |

## Environment

Read at request time through `loadEnv(..., { scope: 'desk' })` (never at build time). In Docker the desk gets the
shared `.env` plus `.env.desk` and nothing else: no Marker, imagegen or cloud-LLM key reaches it, and its runtime
builds only the database, Etsy, Printify, storage and image-tools clients (the others throw if called).

- `DESK_PASSWORD_HASH`: `scrypt$N$r$p$saltB64$hashB64`, made with `./deploy/compose.sh run --rm --no-deps worker hash-password`
  (or `npx tsx apps/worker/src/cli.ts hash-password` from the repo root; not `npm run worker`, which starts the worker loop).
- `DESK_SESSION_SECRET`: at least 32 random characters, e.g. `openssl rand -base64 48`. Rotating it signs everyone out.
- `DESK_ORIGIN`: the exact HTTPS origin you open in the browser, e.g. `https://secforit-home.<tailnet>.ts.net`.
  Every POST (all server actions) must carry this `Origin`; without it, production refuses every change.
- From the shared `.env`: `MODE`, `DATABASE_URL`, `STORAGE_DIR`, and in live mode the Etsy and Printify keys.

## Security

- Session: `__Host-desk_session` cookie, HMAC-SHA256 over issued-at + random nonce, 12 h, `HttpOnly; Secure; SameSite=Strict`.
  Sign out revokes every session issued until then (all devices) for the life of the process, but only for a
  caller with a valid session (the action is reachable from the public `/login`; without a session it just clears
  the caller's own cookie); rotating `DESK_SESSION_SECRET` is the durable "sign out everywhere".
- `proxy.ts` (Next 16's middleware) runs on every request except `/_next/static`: origin check on mutations,
  session check on everything but `/login` and `/healthz`, per-request CSP nonce (`strict-dynamic`, no `unsafe-eval`).
  Pages, server actions and the asset route re-check the session themselves.
- Headers on every response: CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`
  (not `no-referrer`, which would make browsers send `Origin: null`), `X-Content-Type-Options: nosniff`,
  `Permissions-Policy`, HSTS.
- Uploads: PNG only, 50 MB (server action body limit `50mb`); the service re-validates and re-encodes with sharp.
- Image downloads (`/products/<id>/asset/<kind>`) are served `private, no-store` under
  `default-src 'none'; sandbox`, only after the session check.
- `loadEnv` reads every `FOO_FILE` variable into `FOO`. The desk passes it only the `*_FILE` variables that
  target core keys (`lib/envScope.ts`), so unrelated `*_FILE` variables from the base image or the shared `.env`
  (e.g. `SSL_CERT_FILE`, or the worker's old `WORKER_HEARTBEAT_FILE`, now `WORKER_HEARTBEAT_PATH`) cannot make
  the desk configuration invalid.

## Develop and check

```bash
npm run dev -w @etsy-agents/desk                         # http://127.0.0.1:3000 (needs the env above)
DESK_FAKE=1 npm run dev -w @etsy-agents/desk             # in-memory fake service, dev only
npx vitest run apps/desk/lib                             # auth, rate limit, origin, validation tests
cd apps/desk && npx tsc --noEmit && MODE=mock npx next build
```

`DESK_FAKE=1` only works under `next dev`: production builds inline `NODE_ENV=production` and drop the fake.
Without `DESK_ORIGIN`, `next dev` accepts mutations only from `http://localhost:3000` and `http://127.0.0.1:3000`;
set `DESK_ORIGIN` when you use another port. After a successful upload, approval or rejection the product page
shows a fixed confirmation (`?done=uploaded|approved|rejected`).

## Container

`apps/desk/Dockerfile.desk`, built from the repository root:

```bash
docker build -f apps/desk/Dockerfile.desk -t etsy-agents-desk .
```

Runs as `node` (uid 1000) on `0.0.0.0:3000` inside the container. Publish it only on `127.0.0.1:3000` and
expose it with `tailscale serve --bg --https=443 http://127.0.0.1:3000`. With a read-only root filesystem,
mount tmpfs on `/tmp` and `/app/apps/desk/.next/cache`.
