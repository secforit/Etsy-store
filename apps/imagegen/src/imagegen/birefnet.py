"""BiRefNet foreground matting (MIT) via transformers, as on the model card (huggingface.co/ZhengPeng7/BiRefNet):

    birefnet = AutoModelForImageSegmentation.from_pretrained('ZhengPeng7/BiRefNet', trust_remote_code=True)
    birefnet.to('cuda').eval().half()
    transform: Resize((1024, 1024)) -> ToTensor -> Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
    preds = birefnet(input_images)[-1].sigmoid().cpu()

trust_remote_code runs Python from the model repository, so the revision is pinned to a reviewed commit
(config.BIREFNET_REVISION) and never floats to "main".
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
from PIL import Image

from .config import Settings
from .gpu import resolve_device, translate_oom
from .interfaces import PipelineError

log = logging.getLogger("imagegen.birefnet")

RESOLUTION = (1024, 1024)
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class BiRefNetMatting:
    name = "birefnet"

    def __init__(self, settings: Settings) -> None:
        import torch
        from transformers import AutoModelForImageSegmentation

        self._device = resolve_device(settings.device)
        self._dtype = torch.float16 if self._device.type == "cuda" else torch.float32
        with translate_oom():
            model: Any = AutoModelForImageSegmentation.from_pretrained(
                settings.birefnet_repo,
                revision=settings.birefnet_revision,
                trust_remote_code=True,
                local_files_only=settings.offline,
            )
            model.to(self._device)
            model.eval()
            if self._dtype == torch.float16:
                model.half()
        self._model: Any = model
        self._torch = torch
        log.info("birefnet loaded", extra={"repo": settings.birefnet_repo, "revision": settings.birefnet_revision[:12]})

    def alpha(self, image: Image.Image) -> Image.Image:
        if self._model is None:
            raise PipelineError("matting is closed")
        torch = self._torch
        rgb = image.convert("RGB")
        resized = rgb.resize(RESOLUTION, Image.Resampling.BILINEAR)
        arr = (np.asarray(resized, dtype=np.float32) / 255.0 - MEAN) / STD  # HWC
        x = torch.from_numpy(np.ascontiguousarray(arr.transpose(2, 0, 1))).unsqueeze(0)
        x = x.to(self._device, dtype=self._dtype)
        with translate_oom(), torch.inference_mode():
            pred = self._model(x)[-1].sigmoid().float().cpu()[0, 0].numpy()
        mask = Image.fromarray(np.clip(np.rint(pred * 255.0), 0, 255).astype(np.uint8))
        return mask.resize(rgb.size, Image.Resampling.BILINEAR)

    def close(self) -> None:
        model, self._model = self._model, None
        if model is not None:
            try:
                model.to("cpu")
            except Exception:
                log.warning("birefnet: move to cpu failed", exc_info=True)
            del model
