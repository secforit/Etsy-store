"""Factories for the real GPU pipelines. Each heavy module is imported only when its model is first needed."""

from __future__ import annotations

from .config import Settings
from .interfaces import Generator, Matting, Upscaler
from .models import PipelineFactories


def real_factories(settings: Settings) -> PipelineFactories:
    def generator() -> Generator:
        from .flux import FluxKleinGenerator

        return FluxKleinGenerator(settings)

    def matting() -> Matting:
        from .birefnet import BiRefNetMatting

        return BiRefNetMatting(settings)

    def upscaler() -> Upscaler:
        from .esrgan import RealEsrganUpscaler

        return RealEsrganUpscaler(settings)

    def free_memory() -> None:
        from .gpu import free_cuda_memory

        free_cuda_memory()

    return PipelineFactories(generator=generator, matting=matting, upscaler=upscaler, free_memory=free_memory)
