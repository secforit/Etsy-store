# Running the stack on a Mac (cloud models)

With the agents on the Nous Research API and the images on fal.ai, nothing needs an NVIDIA GPU, so the whole stack
(Postgres, worker, desk) runs on a Mac (Apple Silicon or Intel) under Docker Desktop. The Compose file, images and
scripts are the same as on the Linux server (`docs/RUNBOOK.md`); this page lists only what differs.

## Models

`./deploy/init-env.sh --cloud` writes this setup into `.env.worker`:

| Role | Setting | Model (Nous Portal id) | Agents |
| --- | --- | --- | --- |
| Decisions | `NOUS_MODEL_LARGE` | `deepseek/deepseek-v4-pro` | niche_validator (go/no-go), compliance_guard (block/pass), analyst (weekly report) |
| Workload | `NOUS_MODEL_SMALL` | `deepseek/deepseek-v4-flash` (the 0731 release) | trend_scout, designer, listing_writer, qa_publisher |
| Image checks | `NOUS_MODEL_VISION` | you pick it (see step 4) | compliance_guard (final look at the art), qa_publisher (mockups) |
| Art, backgrounds, upscaling | `IMAGEGEN_PROVIDER=fal` | FLUX.2 klein 4B, BiRefNet v2, Real-ESRGAN x4 on fal.ai | designer, qa_publisher |

The split comes from `LLM_TIERS='{"trend_scout":"small","listing_writer":"small"}'`: those two agents are built to
use the large model and move to Flash. The others keep their built-in size. To move an agent, edit `LLM_TIERS`
(`"large"` = Pro, `"small"` = Flash) and restart the worker.

DeepSeek V4 Pro and Flash read text only, so the two image checks need a separate image-capable model. Until
`NOUS_MODEL_VISION` is set, the worker refuses to start in live mode. Confirm every id against your own Portal
catalog with `check-cloud`: the ids above follow the Portal's `<vendor>/<model>` naming, and the ones your key
actually offers are what counts.

## Steps

1. **Install Docker Desktop** (docker.com, Apple Silicon or Intel build) and start it. 4 GB of memory for Docker
   is plenty, since no model runs locally. Turn on "Start Docker Desktop when you sign in" if the Mac should run
   the pipeline unattended.

2. **Get the latest code** in your clone:

   ```bash
   cd ~/Etsy-store        # wherever you cloned it
   git pull
   ```

3. **Create the env files** (mode 600, generated secrets, the cloud preset). The script asks for the Nous and fal
   keys without echoing them. Press Enter to skip one and add it to `.env.worker` later:

   ```bash
   ./deploy/init-env.sh --cloud
   ```

   It never overwrites an existing `.env`, `.env.worker` or `.env.desk`. The desk origin defaults to
   `http://localhost:3000`. For the Tailscale setup in step 8, pass `--desk-origin https://<mac>.<tailnet>.ts.net`.

4. **Check the keys and models, and pick the vision model:**

   ```bash
   ./deploy/compose.sh build
   ./deploy/compose.sh run --rm --no-deps worker check-cloud
   ```

   It shows whether the key was accepted, whether each model is in your catalog and at what price, and which
   image-capable models exist when `NOUS_MODEL_VISION` is missing or text-only. The `Agents` block lists the model
   each agent will use. Put one of the listed image-capable ids in `.env.worker` (`NOUS_MODEL_VISION=...`) and run
   it again until it ends with `Cloud providers: READY`.

5. **Set the desk password:**

   ```bash
   ./deploy/compose.sh run --rm --no-deps worker hash-password
   ```

   Paste the hash into `.env.desk` IN SINGLE QUOTES: `DESK_PASSWORD_HASH='scrypt$...'`.

6. **Start in mock mode** (`MODE=mock` in `.env`: Etsy, Printify, Marker and the models are offline mocks):

   ```bash
   ./deploy/compose.sh up -d
   ./deploy/compose.sh ps          # postgres, worker, desk healthy; no ollama, no imagegen
   ```

   Open http://localhost:3000 in Chrome or Firefox and sign in. (Sign-in over plain http on localhost was tested
   in Chromium; Safari was not tested.) Follow RUNBOOK section 8 for the first mock run, then wipe the mock data
   before going live (`./deploy/compose.sh down && docker volume rm etsy-agents_pgdata etsy-agents_blobs`).

7. **Go live** exactly as in RUNBOOK section 9: Etsy, Printify and Marker keys, `MODE=live`, start paused. Use
   `nano` or any editor for the env files. The RUNBOOK's `sed -i` one-liners are GNU syntax, which is why
   `init-env.sh` exists.

8. **Optional: reach the desk from your phone.** Install Tailscale on the Mac, enable MagicDNS and HTTPS
   certificates in the admin console, then set `DESK_ORIGIN=https://<mac>.<tailnet>.ts.net` in `.env.desk` and run:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:3000
   ```

   (With the App Store version, the CLI is `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.) Never use
   `tailscale funnel`.

## Mac specifics

- **Sleep pauses the pipeline.** The worker runs only while the Mac is awake. Jobs left running when it sleeps are
  requeued by the stale-lock check. For unattended runs on a desktop Mac, prevent sleep while on power (System
  Settings, Energy), or keep `caffeinate -dims` running in a terminal.
- **Run only one live stack.** The Mac and the Linux server each have their own database, so the daily draft cap
  and the spend cap are not shared. Running both live creates duplicate Etsy drafts and up to double the cloud
  spend.
- **Backups:** the default `BACKUP_DIR` is a Linux path. On the Mac, use for example
  `BACKUP_DIR="$HOME/etsy-backups" ./deploy/backup.sh` (crontab works on macOS too). The scripts use `shasum` when
  `sha256sum` is missing.
- **Costs:** every Nous and fal call counts against the daily spend cap. Nous prices come from the Portal
  catalog, and `check-cloud` prints them. Put your real fal prices in the `FAL_COST_*` settings (RUNBOOK
  section 6).
- **Try without Docker first:** `npm install && MODE=mock npm run demo` (Node 22) runs the whole pipeline offline.
