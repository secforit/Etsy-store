"""Lazy model registry. Models load on first use and are all dropped by unload_all() (POST /unload).

Only ever called from the single GPU thread (runner.GpuRunner), except loaded() which reads a snapshot.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar

from .interfaces import Generator, GpuOutOfMemoryError, Matting, ModelUnavailableError, PipelineError, Upscaler

log = logging.getLogger("imagegen.models")

T = TypeVar("T")


@dataclass(frozen=True)
class PipelineFactories:
    generator: Callable[[], Generator]
    matting: Callable[[], Matting]
    upscaler: Callable[[], Upscaler]
    #: Called after models are dropped (real: gc + torch.cuda.empty_cache()).
    free_memory: Callable[[], None]


class ModelManager:
    _SLOTS = ("generator", "matting", "upscaler")

    def __init__(self, factories: PipelineFactories) -> None:
        self._factories = factories
        self._instances: dict[str, Any] = {}
        self._state_lock = threading.Lock()

    def generator(self) -> Generator:
        return self._get("generator")

    def matting(self) -> Matting:
        return self._get("matting")

    def upscaler(self) -> Upscaler:
        return self._get("upscaler")

    def loaded(self) -> list[str]:
        with self._state_lock:
            return [getattr(m, "name", slot) for slot, m in self._instances.items()]

    def _get(self, slot: str) -> Any:
        with self._state_lock:
            inst = self._instances.get(slot)
        if inst is not None:
            return inst
        factory: Callable[[], Any] = getattr(self._factories, slot)
        started = time.monotonic()
        oom: GpuOutOfMemoryError | None = None
        try:
            inst = factory()
        except GpuOutOfMemoryError as e:
            oom = _detached(e)
        except PipelineError:
            raise
        except Exception as e:
            log.exception("model load failed", extra={"slot": slot})
            raise ModelUnavailableError(f"{slot} failed to load ({type(e).__name__})") from e
        if oom is not None:
            # Free what is loaded so the client's retry has the whole card.
            self.unload_all()
            raise oom
        with self._state_lock:
            self._instances[slot] = inst
        log.info("model loaded", extra={"model": getattr(inst, "name", slot), "seconds": round(time.monotonic() - started, 1)})
        return inst

    def unload_all(self) -> list[str]:
        with self._state_lock:
            instances, self._instances = self._instances, {}
        names: list[str] = []
        for slot, inst in instances.items():
            names.append(getattr(inst, "name", slot))
            try:
                inst.close()
            except Exception:
                log.exception("model close failed", extra={"slot": slot})
        del instances
        try:
            self._factories.free_memory()
        except Exception:
            log.exception("free_memory failed")
        if names:
            log.info("models unloaded", extra={"models": names})
        return names

    def run_guarded(self, fn: Callable[[], T]) -> T:
        """Runs GPU work; on CUDA OOM drops every model so VRAM is free for the client's retry."""
        try:
            return fn()
        except GpuOutOfMemoryError as e:
            oom = _detached(e)
        # Outside the except block: the original traceback (which pins activation tensors on the GPU) is gone.
        self.unload_all()
        raise oom


def _detached(e: GpuOutOfMemoryError) -> GpuOutOfMemoryError:
    """Same error without the traceback, whose frames would keep CUDA tensors alive until it is collected."""
    return GpuOutOfMemoryError(str(e))
