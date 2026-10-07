# Runbook: Etsy agent team on secforit-home

How to install, run, back up and fix the stack on Razvan's server. Every command runs from the repository
root (for example `~/etsy-agents`) as your normal user, after it has been added to the `docker` group.

| | |
| --- | --- |
| Host | `secforit-home`: Ubuntu 26.04 LTS, i9-12900K, 61 GiB RAM, RTX 3060 12 GB (driver 595, CUDA 13.2), LAN 10.2.3.2/24, Tailscale up |
| Text models | `gemma4:12b` on Ollama, every agent, vision included (about 8 GB VRAM at 16k context) |
| Image models | FLUX.2 [klein] 4B + BiRefNet + Real-ESRGAN x4plus in the `imagegen` sidecar (CPU offload) |
| Reached at | `https://secforit-home.<tailnet>.ts.net` through `tailscale serve`, from your tailnet devices only |
| Public ports | none. The desk listens on `127.0.0.1:3000`; nothing else is published |

## 1. What runs

`./deploy/compose.sh` wraps `docker compose` with the project name `etsy-agents`, `deploy/docker-compose.yml`
and the repository's `.env`. Use it for every command below.

| Service | What it does | GPU | Network | Data |
| --- | --- | --- | --- | --- |
| `postgres` | Database (`postgres:16-alpine`, uid 70) | no | backend | volume `pgdata` |
| `ollama` | Local LLM server, one model loaded, one request at a time | yes | backend, egress | volume `ollama` |
| `imagegen` | FLUX.2 klein 4B / BiRefNet / Real-ESRGAN sidecar, bearer token required | yes | backend, egress | volume `hf-models` (`/models`) |
| `migrate` | One-shot: SQL migrations, before worker and desk start | no | backend | |
| `worker` | The orchestrator: one job at a time, daily trend scan, hourly analyze | no | backend, egress | volume `blobs` |
| `desk` | Approval desk (Next.js) on `127.0.0.1:3000` | no | backend, egress | volume `blobs` |
| `init-volumes` | One-shot: gives the `blobs` and `ollama` volumes to uid 1000 | no | none | |
| `ollama-pull` | One-shot (profile `setup`): downloads `gemma4:12b` | no | backend | |

`backend` is an internal network (no internet). `egress` gives outbound internet to the services that need it:
Etsy, Printify and Marker APIs for worker and desk, model downloads for ollama and imagegen. Postgres never
gets internet access.

Every container runs as a non-root user with `no-new-privileges`, all capabilities dropped, and (except the
imagegen sidecar) a read-only root filesystem. Logs are rotated (10 MB x 5 per container).

The pipeline per product:

```
proposed -> cleared -> designed --(you upload the edited PNG)--> edited -> written -> final_cleared
  -> drafted --(you approve)--> live -> retired          stop states: blocked, rejected
```

You act twice per product in the desk: upload your edited design (`designed`) and approve or reject the
Etsy draft (`drafted`). Everything else is automatic and capped: at most 5 drafts per UTC day and $10 of
cloud spend per UTC day (local models cost $0, so with the default all-local setup the spend stays at $0).

## 2. Install Docker Engine (Ubuntu 26.04)

Remove distribution packages that conflict, then install Docker from Docker's apt repository:

```bash
for p in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do sudo apt-get remove -y $p; done
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg jq
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"     # then log out and back in
docker run --rm hello-world
docker compose version              # must be 2.24 or newer
```

If `apt-get update` reports that Docker has no release for the 26.04 codename yet, replace
`${UBUNTU_CODENAME:-$VERSION_CODENAME}` with `noble` (24.04) in `/etc/apt/sources.list.d/docker.list`.

## 3. Install the NVIDIA Container Toolkit and check the GPU inside a container

The driver (595) is already on the host. Check it first:

```bash
nvidia-smi        # RTX 3060, 12288 MiB, driver 595.x, CUDA 13.2
```

Install the toolkit from NVIDIA's repository and register it with Docker:

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

The real test is `nvidia-smi` inside a container (the toolkit mounts the driver tools into it):

```bash
docker run --rm --gpus all ubuntu:24.04 nvidia-smi
```

You must see the RTX 3060 with 12288 MiB. If you get `could not select device driver "" with capabilities: [[gpu]]`,
the toolkit is not registered: rerun `nvidia-ctk runtime configure` and restart Docker.

If the host has a desktop session, it also uses VRAM (often 300 to 800 MB). The server needs every MB:
`sudo systemctl set-default multi-user.target && sudo reboot` disables the graphical login.

## 4. Get the code and fill `.env`

```bash
cd ~/etsy-agents
cp .env.example .env
chmod 600 .env           # compose.sh refuses to run when .env is readable by others
```

Generate the infrastructure secrets (each command fills an empty line of `.env.example` in place):

```bash
sed -i "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
sed -i "s/^IMAGEGEN_TOKEN=$/IMAGEGEN_TOKEN=$(openssl rand -hex 32)/" .env
echo "DESK_SESSION_SECRET='$(openssl rand -base64 48 | tr -d '\n')'" >> .env
```

Set the desk origin to your machine's tailnet name (Tailscale must have MagicDNS and HTTPS certificates enabled
in the admin console, under DNS):

```bash
host="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
echo "DESK_ORIGIN=https://$host" >> .env
```

Build the images, then make the desk password hash (asked twice, hidden, minimum 12 characters):

```bash
./deploy/compose.sh build
./deploy/compose.sh run --rm --no-deps worker hash-password
```

Paste the printed hash into `.env` IN SINGLE QUOTES, because it contains `$`:

```
DESK_PASSWORD_HASH='scrypt$131072$8$1$....$....'
```

Rules for `.env` (also written at the top of `.env.example`): leave keys you do not use commented out (an empty
`KEY=` is rejected at start-up and the error names the key), single-quote any value with `$` or JSON, never
commit or share the file, and keep a copy in your password manager (backups do not contain it).

## 5. Start the stack (mock mode)

`.env` starts with `MODE=mock`: Etsy, Printify, Marker, the LLM and image generation are offline mocks, so the
first start exercises the whole stack without touching any external account.

```bash
./deploy/compose.sh up -d
./deploy/compose.sh ps
```

Expected: `postgres`, `ollama`, `worker` and `desk` healthy; `imagegen` running (healthy once its own check
passes); `init-volumes` and `migrate` exited with code 0.

## 6. Download the models

### Ollama: gemma4:12b (about 8 GB)

```bash
./deploy/compose.sh --profile setup run --rm ollama-pull
./deploy/compose.sh exec ollama ollama list          # gemma4:12b listed
```

Quick GPU test, then free the VRAM again:

```bash
./deploy/compose.sh exec ollama ollama run gemma4:12b "Reply with OK."
./deploy/compose.sh exec ollama ollama ps            # PROCESSOR must say 100% GPU
./deploy/compose.sh exec ollama ollama stop gemma4:12b
```

### Hugging Face: FLUX.2 [klein] 4B, BiRefNet, Real-ESRGAN x4plus

The sidecar downloads its weights into the `hf-models` volume (`/models`) on first use. Download them ahead
of time so the first design job does not wait. `docs/MODELS.md` lists the exact repository ids, pinned
revisions, licences and sizes. The sidecar's own downloader fetches exactly the pinned revisions it loads
(FLUX.2 klein 4B and BiRefNet from Hugging Face, Real-ESRGAN x4plus from its GitHub release, SHA-256 checked),
so offline mode works afterwards; do not use a bare `snapshot_download`, which fetches `main` plus files the
sidecar never loads:

```bash
./deploy/compose.sh exec imagegen python -m imagegen.download          # ~15.5 GB into the hf-models volume
./deploy/compose.sh exec imagegen python -m imagegen.download --check  # verify the files, no network
```

If a repository says you must accept its terms, accept them on huggingface.co with your account, create a
read-only token, put `HF_TOKEN=...` in `.env` and run `./deploy/compose.sh up -d imagegen` before retrying.

When every model is downloaded, stop all calls to huggingface.co:

```bash
echo "IMAGEGEN_HF_OFFLINE=1" >> .env
./deploy/compose.sh up -d imagegen
```

### Check the GPU stack

```bash
./deploy/compose.sh run --rm --no-deps worker check-gpu
```

It asks Ollama for its models (`/api/tags`, `/api/ps`) and the sidecar for `/healthz` (with the token), prints
what is missing and how to fix it, and ends with `GPU stack: READY`.

## 7. Open the desk over Tailscale

```bash
sudo tailscale set --operator="$USER"                     # once, so `tailscale serve` works without sudo
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status
```

Open `https://secforit-home.<tailnet>.ts.net` (the exact `DESK_ORIGIN`) from a device on your tailnet and sign
in. The configuration survives reboots. Never use `tailscale funnel`: that would put the desk on the public
internet. To limit which tailnet devices can reach the server, add an ACL rule in the Tailscale admin console.

## 8. First run (mock mode)

1. Offline demo in a throwaway in-memory database (does not touch Postgres or the volumes):

   ```bash
   ./deploy/compose.sh run --rm --no-deps worker demo     # prints a summary, exit code 0
   ```

2. The real stack in mock mode: the worker schedules the daily `trend_scan` at `TREND_SCAN_HOUR_UTC` (default
   04:00 UTC; on a first start after that hour it runs at once) and an `analyze` every hour. Watch it:

   ```bash
   ./deploy/compose.sh logs -f worker
   ```

   In the desk: the queue shows products in `designed`. Open one, download the raw art, edit it, upload the PNG.
   The listing copy, final compliance check and QA follow; the product reaches `drafted`. Approve or reject it.

3. Before going live, wipe the mock data so it never mixes with real listings:

   ```bash
   ./deploy/compose.sh down
   docker volume rm etsy-agents_pgdata etsy-agents_blobs
   ```

   (The `ollama` and `hf-models` volumes keep the downloaded models.)

## 9. Going live

### Accounts and keys

* **Etsy**: create an app at https://www.etsy.com/developers/your-apps. `ETSY_API_KEY` is the keystring,
  `ETSY_SHARED_SECRET` the shared secret. The worker needs an OAuth 2.0 refresh token with the scopes
  `listings_r listings_w transactions_r`, obtained once with the PKCE flow (register a redirect URI in the app,
  for example your desk origin plus `/oauth/callback`; the page may 404, you only need the `code` in its URL):

  ```bash
  KEY=<keystring>; REDIRECT='https://secforit-home.<tailnet>.ts.net/oauth/callback'
  VERIFIER="$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)"
  CHALLENGE="$(printf '%s' "$VERIFIER" | openssl dgst -binary -sha256 | openssl base64 | tr '+/' '-_' | tr -d '=\n')"
  STATE="$(openssl rand -hex 16)"
  echo "https://www.etsy.com/oauth/connect?response_type=code&client_id=$KEY&redirect_uri=$REDIRECT&scope=listings_r%20listings_w%20transactions_r&state=$STATE&code_challenge=$CHALLENGE&code_challenge_method=S256"
  # open the URL, approve, copy `code` from the redirect URL (check that `state` matches), then:
  curl -s -X POST https://api.etsy.com/v3/public/oauth/token \
    -d grant_type=authorization_code -d client_id="$KEY" -d redirect_uri="$REDIRECT" \
    -d code='<code>' -d code_verifier="$VERIFIER" | jq '{refresh_token, expires_in}'
  ```

  Put `refresh_token` in `ETSY_REFRESH_TOKEN` and your numeric shop id in `ETSY_SHOP_ID`. Etsy rotates the
  refresh token on every refresh; the worker keeps the current one in the `blobs` volume (`.secrets/`, mode 600),
  so the value in `.env` is only the starting point. Check the Etsy Open API v3 documentation if a step differs.
* **Printify** (free plan): connect the Etsy shop in Printify and set its Etsy publishing so products are
  created as drafts (manual publishing). The pipeline relies on Printify creating a DRAFT that you approve in
  the desk. Create a personal access token (`PRINTIFY_API_TOKEN`); the shop id (`PRINTIFY_SHOP_ID`) is the `id`
  of the Etsy shop in `curl -s -H "Authorization: Bearer $TOKEN" https://api.printify.com/v1/shops.json`.
* **Marker API** (USPTO trademark search): `MARKER_API_USERNAME`, `MARKER_API_PASSWORD`.
* **Pinterest** (optional): `PINTEREST_ACCESS_TOKEN`. Without it that trend source returns nothing.
* **Etsy shop settings**: declare Printify as a production partner, and keep the shop's AI-assisted design
  disclosure consistent with the text the Listing Writer appends to every description.

### Switch to live, paused

```bash
nano .env                     # MODE=live and the keys above
./deploy/compose.sh up -d postgres
./deploy/compose.sh run --rm migrate
./deploy/compose.sh exec postgres psql -U etsy -d etsy -c "UPDATE settings SET paused = true, updated_at = now()"
./deploy/compose.sh up -d
./deploy/compose.sh run --rm --no-deps worker check-gpu
```

Pin the Printify catalog (blueprint and US print provider per product type). Look first, then pin:

```bash
./deploy/compose.sh run --rm --no-deps worker setup-catalog --dry-run
./deploy/compose.sh run --rm --no-deps worker setup-catalog
# or pin explicit ids:  ... setup-catalog --type mug --blueprint <id> --provider <id>
```

Reading variant costs can create and immediately delete a short-lived Printify "cost probe" product; every
such write is in the audit log. Then open the desk, review Settings (caps, blocklist), and press Resume.

### Going-live checklist

- [ ] `docker run --rm --gpus all ubuntu:24.04 nvidia-smi` shows the RTX 3060
- [ ] `check-gpu` says `GPU stack: READY`; `IMAGEGEN_HF_OFFLINE=1` after the weights are in place
- [ ] `demo` exits 0
- [ ] Mock data wiped (fresh `pgdata` and `blobs` volumes) before `MODE=live`
- [ ] `.env` is mode 600, the password hash is single-quoted, `DESK_ORIGIN` is exactly the URL you open
- [ ] Desk: sign-in works over `https://…ts.net`, wrong passwords get rate limited, sign-out works
- [ ] Only `127.0.0.1:3000` is published: `sudo ss -tlnp` shows no Docker port on `0.0.0.0` or `[::]`
- [ ] Printify's Etsy connection creates drafts; the first draft checked on Etsy before approving anything
- [ ] `setup-catalog` pinned tshirt, mug and poster with plausible costs; `EUR_TO_USD` is current
- [ ] Settings: 5 drafts/day, $10/day cloud spend, blocklist reviewed (brands, characters, celebrities, teams)
- [ ] All agents local (`LLM_ROUTES` unset), or `LLM_PRICES_JSON` covers every cloud model id
- [ ] Backup cron installed, one backup made, `restore.sh` tried on a scratch machine if possible
- [ ] `OLLAMA_VERSION` pinned to the version that worked

## 10. Daily operations

```bash
./deploy/compose.sh ps                                   # health of every service
./deploy/compose.sh logs -f --tail 100 worker            # what the agents are doing (JSON lines)
./deploy/compose.sh run --rm --no-deps worker status     # paused?, drafts and spend vs caps, products, jobs, failures
./deploy/compose.sh run --rm --no-deps worker retry-failed [--kind qa_publish] [--job <uuid>]
```

* **Pause / resume**: the desk dashboard or Settings. The worker finishes the job in progress, then claims
  nothing until you resume. Periodic jobs are still queued, at most one pending per kind, so no backlog builds up.
* **Caps** reset at 00:00 UTC. At the draft cap, `qa_publish` jobs wait (they are not failed and keep their
  attempts). At the spend cap, only jobs of agents routed to a cloud model wait; local jobs continue.
* **Failed jobs**: a job is retried with backoff (30 s, 2 min, 8 min...) and fails after 3 attempts, or at once
  when retrying cannot help (invalid model output, missing data). `status` shows the last errors; fix the cause,
  then `retry-failed`.
* **Stop the worker**: `./deploy/compose.sh stop worker` waits up to 5 minutes for the current job. A job killed
  mid-way is requeued automatically after 15 minutes.
* **Audit log** (every human action and every external write):

  ```bash
  ./deploy/compose.sh exec postgres psql -U etsy -d etsy -c \
    "SELECT created_at, actor, action, entity, entity_id FROM audit_log ORDER BY created_at DESC LIMIT 30"
  ```

## 11. Backups and restore

`deploy/backup.sh` writes `etsy-agents-<UTC time>/` with `db.dump` (pg_dump custom format, checked with
`pg_restore --list`), `blobs.tar.gz` (designs, edited files, print files) and `SHA256SUMS`, and deletes backups
older than 14 days. Secrets are not included: not `.env`, not the rotated Etsy token.

```bash
sudo install -d -o "$USER" -g "$USER" -m 700 /srv/etsy-agents/backups
./deploy/backup.sh                                       # try it once by hand
echo "17 3 * * * $USER $HOME/etsy-agents/deploy/backup.sh >> $HOME/etsy-agents-backup.log 2>&1" \
  | sudo tee /etc/cron.d/etsy-agents-backup > /dev/null
```

Options: `BACKUP_DIR=/other/path`, `BACKUP_KEEP_DAYS=30`. Copy the backup directory off the machine too (NAS,
external disk, or an encrypted `restic` repository). The models (`ollama`, `hf-models` volumes) are not backed
up: they can be downloaded again.

Restore (stops worker and desk, replaces the database and the blobs, starts everything again):

```bash
./deploy/restore.sh /srv/etsy-agents/backups/etsy-agents-20261006T031717Z
```

On a new machine, the rotated Etsy token is not in the backup: if `ETSY_REFRESH_TOKEN` in `.env` is older than
the last rotation, get a new one (section 9).

## 12. Rotating secrets

| Secret | How | Then |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `./deploy/compose.sh exec postgres psql -U etsy -d etsy`, then `\password etsy` (hex value), then put the same value in `.env`. Changing `.env` alone does nothing: Postgres reads it only on the first start. | `./deploy/compose.sh up -d` |
| `IMAGEGEN_TOKEN` | `openssl rand -hex 32` into `.env` | `./deploy/compose.sh up -d imagegen worker desk` |
| `DESK_SESSION_SECRET` | `openssl rand -base64 48` into `.env` (single quotes). Signs every session out. | `./deploy/compose.sh up -d desk` |
| `DESK_PASSWORD_HASH` | `./deploy/compose.sh run --rm --no-deps worker hash-password`, paste in single quotes | `./deploy/compose.sh up -d desk` |
| `ETSY_REFRESH_TOKEN` | New token with the PKCE flow (section 9). The stored rotated token belongs to the old value and is ignored automatically. To cut off the old grant, also revoke the app's access in your Etsy account. | `./deploy/compose.sh up -d worker desk` |
| `ETSY_API_KEY` / `ETSY_SHARED_SECRET` | Etsy developer portal; a new keystring also needs a new refresh token | `up -d worker desk` |
| `PRINTIFY_API_TOKEN` | Create a new token in Printify, put it in `.env`, then delete the old one | `up -d worker desk` |
| `MARKER_API_*`, `PINTEREST_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `RECRAFT_API_KEY`, `HF_TOKEN` | Issue the new value at the provider, update `.env`, revoke the old one | `up -d worker desk` (`imagegen` for `HF_TOKEN`) |

After any change: `./deploy/compose.sh run --rm --no-deps worker check-gpu` and `... worker status`.

## 13. VRAM troubleshooting (RTX 3060, 12 GB)

Budget: `gemma4:12b` at 16k context needs about 8 GB; FLUX.2 klein 4B in bf16 needs about 13 GB, so the sidecar
streams it from RAM with CPU offload. The two never hold VRAM together: before image work the worker's
GpuCoordinator unloads every Ollama model (`keep_alive: 0`), and before LLM work it calls the sidecar's
`/unload`. Ollama keeps at most one model loaded (`OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`).

See what holds VRAM:

```bash
nvidia-smi
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
./deploy/compose.sh exec ollama ollama ps
./deploy/compose.sh run --rm --no-deps worker check-gpu      # also lists the sidecar's loaded models
```

| Symptom | Fix |
| --- | --- |
| `CUDA out of memory` in `imagegen` logs | Something else holds VRAM. `./deploy/compose.sh exec ollama ollama stop gemma4:12b`; check `nvidia-smi` for host processes (desktop session, browser, another container) and stop them. Then retry the job (`retry-failed --kind design`). |
| `ollama ps` shows a CPU share (for example `40%/60% CPU/GPU`), LLM jobs very slow | The model did not fit. Free VRAM as above; lower `OLLAMA_NUM_CTX` to `8192` in `.env` and `./deploy/compose.sh up -d worker`; optionally add `OLLAMA_KV_CACHE_TYPE: q8_0` to the `ollama` environment in `deploy/docker-compose.yml` (needs flash attention, already on) and `./deploy/compose.sh up -d ollama`. |
| Both GPU services stuck after a crash | `./deploy/compose.sh restart imagegen ollama`, then `check-gpu`. |
| First design job slow or 503 from the sidecar | It loads (or downloads) the weights on first use. Download them in advance (section 6). |
| `could not select device driver "nvidia"` when starting | NVIDIA Container Toolkit not registered (section 3). |
| GPU visible on the host but not in a container | `docker run --rm --gpus all ubuntu:24.04 nvidia-smi`; after a driver upgrade, reboot the host. |

## 14. Other problems

| Symptom | Cause and fix |
| --- | --- |
| `compose.sh: .env is readable by group/others` | `chmod 600 .env` |
| `required variable POSTGRES_PASSWORD is missing a value` | Fill `POSTGRES_PASSWORD` and `IMAGEGEN_TOKEN` in `.env` (section 4). |
| `Invalid environment: <KEY>: ...` in worker or desk logs | That key is empty or malformed in `.env`. Comment out unused keys; single-quote JSON and the password hash. |
| `migrate` exits non-zero, `password authentication failed` | `.env` password differs from the one Postgres was created with. Use the original, or change it (section 12). |
| Desk sign-in works but every change is refused | `DESK_ORIGIN` is not exactly the URL in the browser (scheme, host, no trailing slash). |
| `worker` unhealthy | The process stopped writing its heartbeat: `./deploy/compose.sh logs --tail 200 worker`, then `./deploy/compose.sh restart worker`. |
| A product sits in an automated state (`proposed`, `edited`...) | Its job failed: `status` shows the error; fix it, then `retry-failed`. |
| `Permission denied` under `/models` in `imagegen` logs | The `hf-models` volume belongs to another uid: `docker run --rm -v etsy-agents_hf-models:/models busybox chown -R 1000:1000 /models` (the imagegen image runs as uid/gid 1000). |
| `read-only file system` errors from `ollama` | A newer Ollama writes somewhere new: report it, and meanwhile remove `read_only: true` from the `ollama` service. |
| The scan did not run today | It runs once a day after `TREND_SCAN_HOUR_UTC`, never while paused, and not while yesterday's scan is still pending. |

## 15. Updating

```bash
cd ~/etsy-agents
./deploy/backup.sh
git pull                                  # or copy the new release over the old files (keep .env)
./deploy/compose.sh build
./deploy/compose.sh up -d                 # migrate runs first, then worker and desk are recreated
./deploy/compose.sh run --rm --no-deps worker status
```

To update the models, change `OLLAMA_VERSION` (and pull again) or the sidecar's model ids (see
`docs/MODELS.md`), one at a time, and run `check-gpu` plus one design job before resuming normal work.

## 16. Security checks (monthly)

```bash
sudo ss -tlnp | grep -v '127.0.0' | grep -i docker          # must print nothing
./deploy/compose.sh ps --format '{{.Name}}\t{{.Ports}}'      # only the desk: 127.0.0.1:3000->3000/tcp
./deploy/compose.sh exec worker id                           # uid=1000(node)
stat -c '%a %n' .env /srv/etsy-agents/backups                # 600 and 700
tailscale serve status                                       # serve only, no funnel
```

Also read the audit log for unexpected `printify.*` or `etsy.*` writes, and check that the newest backup
directory exists.
