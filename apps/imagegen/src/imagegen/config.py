"""Settings for the imagegen sidecar, read from the environment only.

Secrets: IMAGEGEN_TOKEN (or IMAGEGEN_TOKEN_FILE for a Docker secret). The token is never logged or returned.
Model ids and revisions are pinned here; see docs/MODELS.md before changing any of them.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------------------------------------------------
# Pinned models (licences checked: all allow commercial use of the model and its outputs). docs/MODELS.md has details.
# ---------------------------------------------------------------------------------------------------------------------

#: FLUX.2 [klein] 4B, Apache-2.0. Commit on huggingface.co pinned for reproducible weights.
FLUX_REPO = "black-forest-labs/FLUX.2-klein-4B"
FLUX_REVISION = "e7b7dc27f91deacad38e78976d1f2b499d76a294"

#: BiRefNet (general), MIT. Loaded with trust_remote_code, so the revision MUST stay pinned to a reviewed commit
#: (this one contains the transformers 5 meta-device fix: np.linspace instead of tensor.item()).
BIREFNET_REPO = "ZhengPeng7/BiRefNet"
BIREFNET_REVISION = "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4"

#: Real-ESRGAN x4plus, BSD-3-Clause. Official release asset; verified by SHA-256 before loading.
ESRGAN_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
ESRGAN_SHA256 = "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1"
ESRGAN_FILENAME = "RealESRGAN_x4plus.pth"

#: The ONLY model pins the sidecar runs by default: (repository, revision) pairs whose licence was checked for
#: commercial use and, for BiRefNet (trust_remote_code), whose remote code at that commit was reviewed. A mirror,
#: re-upload or fine-tune under another id, another revision, or other Real-ESRGAN weights is refused unless
#: IMAGEGEN_ALLOW_UNREVIEWED_MODEL=1 (then logged at error level). Add a pair here only after that review.
APPROVED_FLUX_MODELS = frozenset({(FLUX_REPO.lower(), FLUX_REVISION)})
APPROVED_BIREFNET_MODELS = frozenset({(BIREFNET_REPO.lower(), BIREFNET_REVISION)})
APPROVED_ESRGAN_SHA256 = frozenset({ESRGAN_SHA256})

#: Repositories whose licence forbids commercial use. Refused always, even with IMAGEGEN_ALLOW_UNREVIEWED_MODEL=1.
NON_COMMERCIAL_REPOS = frozenset(
    r.lower()
    for r in (
        "black-forest-labs/FLUX.1-dev",
        "black-forest-labs/FLUX.1-Kontext-dev",
        "black-forest-labs/FLUX.1-Krea-dev",
        "black-forest-labs/FLUX.1-Fill-dev",
        "black-forest-labs/FLUX.1-Canny-dev",
        "black-forest-labs/FLUX.1-Depth-dev",
        "black-forest-labs/FLUX.1-Redux-dev",
        "black-forest-labs/FLUX.2-dev",
        "black-forest-labs/FLUX.2-klein-9B",
        "black-forest-labs/FLUX.2-klein-base-9B",
    )
)

# ---------------------------------------------------------------------------------------------------------------------
# Request limits (BUILD_SPEC "imagegen" brief + security rule 6)
# ---------------------------------------------------------------------------------------------------------------------

MAX_PROMPT_CHARS = 2000
MIN_SIDE = 256
MAX_SIDE = 2048
SIDE_MULTIPLE = 16
MAX_SEED = 2**53 - 1  # the worker parses x-seed into a JS number: keep it exact
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_JSON_BYTES = 64 * 1024
MAX_IMAGE_SIDE = 12_000  # same ceiling as desk uploads (security rule 6); applies to upscale input AND output
MAX_IMAGE_PIXELS = MAX_IMAGE_SIDE * MAX_IMAGE_SIDE
MIN_TOKEN_CHARS = 24


class ConfigError(ValueError):
    """Invalid configuration; the message names the variable, never its value."""


def _flag(value: str | None, default: bool) -> bool:
    if value is None or value.strip() == "":
        return default
    v = value.strip().lower()
    if v in ("1", "true", "yes", "on"):
        return True
    if v in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"expected a boolean, got {v[:8]!r}")


def _int(env: Mapping[str, str], key: str, default: int, lo: int, hi: int) -> int:
    raw = env.get(key)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        raise ConfigError(f"{key} must be an integer") from None
    if not lo <= value <= hi:
        raise ConfigError(f"{key} must be between {lo} and {hi}")
    return value


def _read_secret(env: Mapping[str, str], key: str) -> str | None:
    """KEY or KEY_FILE (Docker secret). Never echoes the value."""
    value = env.get(key)
    if value:
        return value.strip()
    path = env.get(f"{key}_FILE")
    if path:
        try:
            return Path(path).read_text(encoding="utf-8").strip()
        except OSError:
            raise ConfigError(f"{key}_FILE is not readable") from None
    return None


@dataclass(frozen=True)
class Settings:
    token: str = field(repr=False)
    host: str = "0.0.0.0"  # inside the container; compose publishes NO port
    port: int = 8000
    device: str = "cuda"
    models_dir: Path = Path("/models")
    offline: bool = False

    flux_repo: str = FLUX_REPO
    flux_revision: str = FLUX_REVISION
    flux_cpu_offload: bool = True
    flux_steps: int = 4
    flux_guidance: float = 1.0

    birefnet_repo: str = BIREFNET_REPO
    birefnet_revision: str = BIREFNET_REVISION

    esrgan_path: Path = Path("/models/realesrgan") / ESRGAN_FILENAME
    esrgan_url: str = ESRGAN_URL
    esrgan_sha256: str = ESRGAN_SHA256
    upscale_tile: int = 512
    upscale_tile_pad: int = 16

    #: How long a request waits for the GPU lock before answering 503 + Retry-After.
    queue_timeout_s: int = 240

    def __post_init__(self) -> None:
        if len(self.token) < MIN_TOKEN_CHARS:
            raise ConfigError(f"IMAGEGEN_TOKEN must be at least {MIN_TOKEN_CHARS} characters")
        for repo in (self.flux_repo, self.birefnet_repo):
            if repo.lower() in NON_COMMERCIAL_REPOS:
                raise ConfigError(f"{repo} has a non-commercial licence and must not be used (see docs/MODELS.md)")
        if not self.esrgan_url.startswith("https://"):
            raise ConfigError("IMAGEGEN_ESRGAN_URL must be https")
        if len(self.esrgan_sha256) != 64 or any(c not in "0123456789abcdef" for c in self.esrgan_sha256):
            raise ConfigError("IMAGEGEN_ESRGAN_SHA256 must be 64 lowercase hex characters")


def unreviewed_models(settings: Settings) -> list[str]:
    """Configured models that are not an approved (repository, revision) pin. Names only, never secrets."""
    out: list[str] = []
    if (settings.flux_repo.lower(), settings.flux_revision) not in APPROVED_FLUX_MODELS:
        out.append(f"FLUX {settings.flux_repo}@{settings.flux_revision[:40]}")
    if (settings.birefnet_repo.lower(), settings.birefnet_revision) not in APPROVED_BIREFNET_MODELS:
        out.append(f"BiRefNet {settings.birefnet_repo}@{settings.birefnet_revision[:40]}")
    if settings.esrgan_sha256 not in APPROVED_ESRGAN_SHA256:
        out.append(f"Real-ESRGAN weights sha256 {settings.esrgan_sha256[:16]}…")
    return out


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    token = _read_secret(env, "IMAGEGEN_TOKEN")
    if not token:
        raise ConfigError("IMAGEGEN_TOKEN (or IMAGEGEN_TOKEN_FILE) is required")
    models_dir = Path(env.get("IMAGEGEN_MODELS_DIR") or "/models")
    try:
        offline = _flag(env.get("IMAGEGEN_OFFLINE"), False) or _flag(env.get("HF_HUB_OFFLINE"), False)
        cpu_offload = _flag(env.get("IMAGEGEN_FLUX_CPU_OFFLOAD"), True)
        allow_unreviewed = _flag(env.get("IMAGEGEN_ALLOW_UNREVIEWED_MODEL"), False)
    except ConfigError as e:
        raise ConfigError(f"IMAGEGEN_OFFLINE / HF_HUB_OFFLINE / IMAGEGEN_FLUX_CPU_OFFLOAD / IMAGEGEN_ALLOW_UNREVIEWED_MODEL: {e}") from None
    device = (env.get("IMAGEGEN_DEVICE") or "cuda").strip()
    if device not in ("cuda", "cpu") and not device.startswith("cuda:"):
        raise ConfigError("IMAGEGEN_DEVICE must be cuda, cuda:N or cpu")
    settings = _build_settings(env, token, models_dir, offline, cpu_offload, device)
    unreviewed = unreviewed_models(settings)
    if unreviewed:
        if not allow_unreviewed:
            raise ConfigError(
                "unreviewed model(s): "
                + "; ".join(unreviewed)
                + ". Only the pinned, licence-checked models may run (docs/MODELS.md). Set"
                " IMAGEGEN_ALLOW_UNREVIEWED_MODEL=1 only after checking the licence (commercial use) and any remote code."
            )
        logging.getLogger("imagegen").error(
            "running UNREVIEWED model(s): check the licence allows commercial use",
            extra={"models": unreviewed},
        )
    return settings


def _build_settings(
    env: Mapping[str, str], token: str, models_dir: Path, offline: bool, cpu_offload: bool, device: str
) -> Settings:
    return Settings(
        token=token,
        host=(env.get("IMAGEGEN_HOST") or "0.0.0.0").strip(),
        port=_int(env, "IMAGEGEN_PORT", 8000, 1, 65535),
        device=device,
        models_dir=models_dir,
        offline=offline,
        flux_repo=(env.get("IMAGEGEN_FLUX_REPO") or FLUX_REPO).strip(),
        flux_revision=(env.get("IMAGEGEN_FLUX_REVISION") or FLUX_REVISION).strip(),
        flux_cpu_offload=cpu_offload,
        birefnet_repo=(env.get("IMAGEGEN_BIREFNET_REPO") or BIREFNET_REPO).strip(),
        birefnet_revision=(env.get("IMAGEGEN_BIREFNET_REVISION") or BIREFNET_REVISION).strip(),
        esrgan_path=Path(env.get("IMAGEGEN_ESRGAN_PATH") or (models_dir / "realesrgan" / ESRGAN_FILENAME)),
        esrgan_url=(env.get("IMAGEGEN_ESRGAN_URL") or ESRGAN_URL).strip(),
        esrgan_sha256=(env.get("IMAGEGEN_ESRGAN_SHA256") or ESRGAN_SHA256).strip().lower(),
        upscale_tile=_int(env, "IMAGEGEN_UPSCALE_TILE", 512, 64, 2048),
        upscale_tile_pad=_int(env, "IMAGEGEN_UPSCALE_TILE_PAD", 16, 0, 128),
        queue_timeout_s=_int(env, "IMAGEGEN_QUEUE_TIMEOUT_S", 240, 1, 3600),
    )
