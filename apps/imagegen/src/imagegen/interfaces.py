"""Small interfaces between the HTTP layer and the GPU pipelines.

The real implementations (flux.py, birefnet.py, esrgan.py) import torch/diffusers/transformers/spandrel lazily inside
their constructors, so this module, the app and the tests never need those packages.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from PIL import Image


class PipelineError(Exception):
    """Base class for errors the HTTP layer maps to a status code. Messages are safe to log, never to return."""


class ModelUnavailableError(PipelineError):
    """Weights missing (e.g. offline without a download), failed checksum, no CUDA device, or a load failure."""


class GpuOutOfMemoryError(PipelineError):
    """CUDA ran out of memory. The manager frees every model before reporting this."""


@runtime_checkable
class Generator(Protocol):
    """Text-to-image (FLUX.2 [klein] 4B)."""

    name: str

    def generate(self, prompt: str, width: int, height: int, seed: int) -> Image.Image:
        """Returns an RGB image of exactly width x height, deterministic for (prompt, size, seed) on one machine."""
        ...

    def close(self) -> None:
        """Drops every reference to model weights (VRAM and pinned RAM)."""
        ...


@runtime_checkable
class Matting(Protocol):
    """Foreground matting (BiRefNet)."""

    name: str

    def alpha(self, image: Image.Image) -> Image.Image:
        """Returns an 'L' mask of the same size as the RGB input (255 = foreground)."""
        ...

    def close(self) -> None: ...


@runtime_checkable
class Upscaler(Protocol):
    """Super-resolution (Real-ESRGAN x4plus). RGB in, RGB out at exactly factor x the input size."""

    name: str

    def upscale(self, image: Image.Image, factor: int) -> Image.Image: ...

    def close(self) -> None: ...
