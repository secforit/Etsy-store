"""torch helpers shared by the real pipelines. torch is imported inside each function so the app and the tests can
import this module without it."""

from __future__ import annotations

import contextlib
import gc
import logging
from collections.abc import Iterator
from typing import TYPE_CHECKING

from .interfaces import GpuOutOfMemoryError, ModelUnavailableError

if TYPE_CHECKING:  # pragma: no cover
    import torch

log = logging.getLogger("imagegen.gpu")

_configured = False


def configure_torch() -> None:
    """Ampere (RTX 3060, sm_86): TF32 matmuls are fine for inference and much faster than full fp32."""
    global _configured
    if _configured:
        return
    import torch

    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    torch.set_float32_matmul_precision("high")
    _configured = True


def resolve_device(name: str) -> torch.device:
    import torch

    configure_torch()
    device = torch.device(name)
    if device.type == "cuda":
        if not torch.cuda.is_available():
            raise ModelUnavailableError("CUDA requested but no GPU is visible (check the NVIDIA Container Toolkit)")
        index = device.index or 0
        if index >= torch.cuda.device_count():
            raise ModelUnavailableError(f"CUDA device {index} does not exist")
    return device


def half_dtype(device: torch.device) -> torch.dtype:
    """bf16 on CUDA for FLUX (Ampere supports it), fp32 on CPU."""
    import torch

    return torch.bfloat16 if device.type == "cuda" else torch.float32


@contextlib.contextmanager
def translate_oom() -> Iterator[None]:
    """torch.cuda.OutOfMemoryError -> GpuOutOfMemoryError (the HTTP layer answers 503, the manager unloads)."""
    import torch

    try:
        yield
    except torch.cuda.OutOfMemoryError as e:
        raise GpuOutOfMemoryError("CUDA out of memory") from e


def free_cuda_memory() -> None:
    """Returns cached VRAM to the driver after models were dropped, so Ollama can load gemma4:12b."""
    gc.collect()
    try:
        import torch
    except ImportError:  # pragma: no cover - only without torch (tests use fakes)
        return
    # is_initialized(): never create a CUDA context (~300 MB of VRAM) just to empty it.
    if torch.cuda.is_available() and torch.cuda.is_initialized():
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()
        free, total = torch.cuda.mem_get_info()
        log.info("cuda memory released", extra={"free_mib": free // 2**20, "total_mib": total // 2**20})
