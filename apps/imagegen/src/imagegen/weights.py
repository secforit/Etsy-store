"""Real-ESRGAN x4plus weights: fetched once from the official GitHub release into the /models volume and verified
against a pinned SHA-256 before every load. No path or URL ever comes from a request."""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO

from .config import Settings
from .interfaces import ModelUnavailableError

log = logging.getLogger("imagegen.weights")

MAX_WEIGHTS_BYTES = 256 * 1024 * 1024
_CHUNK = 1024 * 1024

#: (url, timeout_s) -> readable binary stream. Injected in tests.
Opener = Callable[[str, float], BinaryIO]


def _default_opener(url: str, timeout: float) -> BinaryIO:
    if not url.startswith("https://"):
        raise ModelUnavailableError("weights URL must be https")
    req = urllib.request.Request(url, headers={"User-Agent": "etsy-agents-imagegen"})
    return urllib.request.urlopen(req, timeout=timeout)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(_CHUNK):
            h.update(chunk)
    return h.hexdigest()


def ensure_esrgan_weights(settings: Settings, opener: Opener | None = None, timeout_s: float = 120.0) -> Path:
    """Returns the verified weights path, downloading it first unless running offline."""
    path = settings.esrgan_path
    if path.is_file():
        if sha256_file(path) != settings.esrgan_sha256:
            raise ModelUnavailableError(f"{path.name}: SHA-256 mismatch; delete it and run `python -m imagegen.download`")
        return path
    if settings.offline:
        raise ModelUnavailableError(f"{path.name} is missing and offline mode is on; run `python -m imagegen.download`")
    path.parent.mkdir(parents=True, exist_ok=True)
    log.info("downloading upscaler weights", extra={"file": path.name})
    fd, tmp_name = tempfile.mkstemp(prefix=".download-", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        h = hashlib.sha256()
        size = 0
        with os.fdopen(fd, "wb") as out, (opener or _default_opener)(settings.esrgan_url, timeout_s) as src:
            while chunk := src.read(_CHUNK):
                size += len(chunk)
                if size > MAX_WEIGHTS_BYTES:
                    raise ModelUnavailableError("weights download exceeds the size limit")
                h.update(chunk)
                out.write(chunk)
        if h.hexdigest() != settings.esrgan_sha256:
            raise ModelUnavailableError("downloaded weights failed the SHA-256 check")
        os.replace(tmp, path)
    except ModelUnavailableError:
        raise
    except Exception as e:
        raise ModelUnavailableError(f"weights download failed ({type(e).__name__})") from e
    finally:
        tmp.unlink(missing_ok=True)
    return path
