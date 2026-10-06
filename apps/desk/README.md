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
| `/products/<id>` | Raw art, edited file, print file, compliance results, listing copy, margin; upload, approve, reject |
| `/settings` | Daily draft cap, daily cloud spend cap, blocklist, pause |
| `/products/<id>/asset/<art\|edited\|print>` | Authenticated image download (`private, no-store`) |
| `/healthz` | Liveness for the container healthcheck (no data) |

## Environment

Read at request time through `loadEnv` (never at build time):

- `DESK_PASSWORD_HASH`: `scrypt$N$r$p$saltB64$hashB64`, made with `npm run worker -- hash-password` (worker CLI).
- `DESK_SESSION_SECRET`: at least 32 random characters, e.g. `openssl rand -base64 48`. Rotating it signs everyone out.
- `DESK_ORIGIN`: the exact HTTPS origin you open in the browser, e.g. `https://secforit-home.<tailnet>.ts.net`.
  Every POST (all server actions) must carry this `Origin`; without it, production refuses every change.
- Everything else the core service needs (`MODE`, `DATABASE_URL`, `STORAGE_DIR`, Etsy keys, ...).

## Security

- Session: `__Host-desk_session` cookie, HMAC-SHA256 over issued-at + random nonce, 12 h, `HttpOnly; Secure; SameSite=Strict`.
- `proxy.ts` (Next 16's middleware) runs on every request except `/_next/static`: origin check on mutations,
  session check on everything but `/login` and `/healthz`, per-request CSP nonce (`strict-dynamic`, no `unsafe-eval`).
  Pages, server actions and the asset route re-check the session themselves.
- Headers on every response: CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`
  (not `no-referrer`, which would make browsers send `Origin: null`), `X-Content-Type-Options: nosniff`,
  `Permissions-Policy`, HSTS.
- Uploads: PNG only, 50 MB (server action body limit `50mb`); the service re-validates and re-encodes with sharp.

## Develop and check

```bash
npm run dev -w @etsy-agents/desk                         # http://127.0.0.1:3000 (needs the env above)
DESK_FAKE=1 npm run dev -w @etsy-agents/desk             # in-memory fake service, dev only
npx vitest run apps/desk/lib                             # auth, rate limit, origin, validation tests
cd apps/desk && npx tsc --noEmit && MODE=mock npx next build
```

`DESK_FAKE=1` only works under `next dev`: production builds inline `NODE_ENV=production` and drop the fake.

## Container

`apps/desk/Dockerfile.desk`, built from the repository root:

```bash
docker build -f apps/desk/Dockerfile.desk -t etsy-agents-desk .
```

Runs as `node` (uid 1000) on `0.0.0.0:3000` inside the container. Publish it only on `127.0.0.1:3000` and
expose it with `tailscale serve --bg --https=443 http://127.0.0.1:3000`. With a read-only root filesystem,
mount tmpfs on `/tmp` and `/app/apps/desk/.next/cache`.
