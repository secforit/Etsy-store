"""Real-ESRGAN x4plus (BSD-3-Clause) loaded with spandrel, run in tiles.

Verified against spandrel 0.4.2 (`ModelLoader().load_from_file(path)` -> `ImageModelDescriptor`; call with a
(1, 3, H, W) float tensor in [0, 1] of the model's dtype/device; output (1, 3, 4H, 4W) in [0, 1]; ESRGAN supports
fp16). spandrel unpickles .pth files with a restricted unpickler, and the file's SHA-256 is checked first anyway.

Factor 2 = the x4 model, then an antialiased bicubic x0.5 per tile on the GPU, so x2 never materialises the x4 image.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
from PIL import Image

from .config import Settings
from .gpu import resolve_device, translate_oom
from .interfaces import GpuOutOfMemoryError, ModelUnavailableError, PipelineError
from .tiling import upscale_tiled
from .weights import ensure_esrgan_weights

log = logging.getLogger("imagegen.esrgan")

MODEL_SCALE = 4
MIN_TILE = 128


class RealEsrganUpscaler:
    name = "realesrgan-x4plus"

    def __init__(self, settings: Settings) -> None:
        import torch
        from spandrel import ImageModelDescriptor, ModelLoader

        path = ensure_esrgan_weights(settings)
        self._device = resolve_device(settings.device)
        descriptor: Any = ModelLoader().load_from_file(str(path))
        if not isinstance(descriptor, ImageModelDescriptor):
            raise ModelUnavailableError("upscaler weights are not an image-to-image model")
        if descriptor.scale != MODEL_SCALE or descriptor.input_channels != 3 or descriptor.output_channels != 3:
            raise ModelUnavailableError("upscaler weights are not a 3-channel x4 model")
        with translate_oom():
            descriptor.to(self._device)
            descriptor.eval()
            if self._device.type == "cuda" and descriptor.supports_half:
                descriptor.half()
        self._dtype = torch.float16 if (self._device.type == "cuda" and descriptor.supports_half) else torch.float32
        self._model: Any = descriptor
        self._torch = torch
        self._tile = settings.upscale_tile
        self._pad = settings.upscale_tile_pad
        log.info("upscaler loaded", extra={"arch": descriptor.architecture.name, "tile": self._tile})

    def upscale(self, image: Image.Image, factor: int) -> Image.Image:
        if self._model is None:
            raise PipelineError("upscaler is closed")
        if factor not in (2, 4):
            raise ValueError("factor must be 2 or 4")
        rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
        tile = self._tile
        while True:
            try:
                out = upscale_tiled(rgb, factor, tile, self._pad, self._run_tile)
                return Image.fromarray(out)
            except GpuOutOfMemoryError:
                if tile // 2 < MIN_TILE:
                    raise
            # Outside the except block, so the failed tile's tensors are released before emptying the cache.
            tile //= 2
            self._torch.cuda.empty_cache()
            log.warning("upscaler: out of memory, retrying with smaller tiles", extra={"tile": tile})

    def _run_tile(self, patch: np.ndarray, factor: int) -> np.ndarray:
        torch = self._torch
        import torch.nn.functional as F

        h, w = patch.shape[:2]
        x = torch.from_numpy(patch).permute(2, 0, 1).unsqueeze(0)
        x = x.to(self._device, dtype=self._dtype).div_(255.0)
        with translate_oom(), torch.inference_mode():
            y = self._model(x)  # (1, 3, 4h, 4w), clamped to [0, 1] by spandrel
            if factor != MODEL_SCALE:
                y = F.interpolate(y.float(), size=(h * factor, w * factor), mode="bicubic", antialias=True, align_corners=False)
            y = y.clamp_(0.0, 1.0).mul_(255.0).round_().to(torch.uint8)
        return y[0].permute(1, 2, 0).contiguous().cpu().numpy()

    def close(self) -> None:
        model, self._model = self._model, None
        if model is not None:
            try:
                model.cpu()
            except Exception:
                log.warning("upscaler: move to cpu failed", exc_info=True)
            del model
