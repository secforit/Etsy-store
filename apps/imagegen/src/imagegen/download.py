"""Pre-download every model into the /models volume (run once, with internet, before the first job):

    ./deploy/compose.sh exec imagegen python -m imagegen.download          # download (about 15.5 GB)
    ./deploy/compose.sh exec imagegen python -m imagegen.download --check  # verify only, no network

Uses the same pinned repositories/revisions as the server, so afterwards IMAGEGEN_HF_OFFLINE=1 works. Loads nothing
onto the GPU.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import replace

from .config import ConfigError, Settings, load_settings
from .interfaces import ModelUnavailableError
from .weights import ensure_esrgan_weights


def _flux(settings: Settings, check: bool) -> str:
    from diffusers import Flux2KleinPipeline

    # DiffusionPipeline.download fetches exactly the component folders from_pretrained needs (not the
    # single-file checkpoint at the repo root).
    path = Flux2KleinPipeline.download(settings.flux_repo, revision=settings.flux_revision, local_files_only=check)
    return str(path)


def _birefnet(settings: Settings, check: bool) -> str:
    from huggingface_hub import snapshot_download

    path = snapshot_download(
        settings.birefnet_repo,
        revision=settings.birefnet_revision,
        allow_patterns=["*.json", "*.py", "model.safetensors"],
        local_files_only=check,
    )
    return str(path)


def _esrgan(settings: Settings, check: bool) -> str:
    return str(ensure_esrgan_weights(replace(settings, offline=check) if check else settings))


STEPS = {"flux": _flux, "birefnet": _birefnet, "esrgan": _esrgan}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m imagegen.download", description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="only verify that the weights are present (no network)")
    parser.add_argument("--only", choices=sorted(STEPS), action="append", help="limit to one model (repeatable)")
    args = parser.parse_args(argv)
    try:
        settings = load_settings()
    except ConfigError as e:
        print(f"config: {e}", file=sys.stderr)
        return 2
    if settings.offline and not args.check:
        print("offline mode is on (HF_HUB_OFFLINE / IMAGEGEN_OFFLINE); run with IMAGEGEN_HF_OFFLINE=0", file=sys.stderr)
        return 2
    failed = 0
    for name in args.only or list(STEPS):
        try:
            where = STEPS[name](settings, args.check)
            print(f"ok       {name}: {where}")
        except Exception as e:
            if not isinstance(e, ModelUnavailableError | OSError | ValueError):
                print(f"error    {name}: unexpected {type(e).__name__}", file=sys.stderr)
            failed += 1
            print(f"MISSING  {name}: {type(e).__name__}: {str(e)[:300]}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
