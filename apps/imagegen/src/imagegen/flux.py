"""FLUX.2 [klein] 4B text-to-image via diffusers' Flux2KleinPipeline (Apache-2.0, commercial use OK).

Verified against the model card (huggingface.co/black-forest-labs/FLUX.2-klein-4B) and diffusers 0.41.0
(`pipelines/flux2/pipeline_flux2_klein.py`):

    pipe = Flux2KleinPipeline.from_pretrained("black-forest-labs/FLUX.2-klein-4B", torch_dtype=torch.bfloat16)
    pipe.enable_model_cpu_offload()
    image = pipe(prompt=..., height=..., width=..., guidance_scale=1.0, num_inference_steps=4,
                 generator=torch.Generator(device="cuda").manual_seed(seed)).images[0]

~13 GB in bf16 does not fit the RTX 3060 (12 GB) in one piece; model CPU offload keeps only the component that is
running (Qwen3 text encoder, then the transformer, then the VAE) on the GPU, the rest in system RAM (61 GiB).
Height and width must be multiples of 16 (vae_scale_factor 8 x 2x2 latent packing): the HTTP layer enforces that.
"""

from __future__ import annotations

import logging
from typing import Any

from PIL import Image

from .config import Settings
from .gpu import half_dtype, resolve_device, translate_oom
from .interfaces import PipelineError

log = logging.getLogger("imagegen.flux")


class FluxKleinGenerator:
    name = "flux2-klein-4b"

    def __init__(self, settings: Settings) -> None:
        import torch
        from diffusers import Flux2KleinPipeline

        self._device = resolve_device(settings.device)
        self._steps = settings.flux_steps
        self._guidance = settings.flux_guidance
        dtype = half_dtype(self._device)
        with translate_oom():
            pipe: Any = Flux2KleinPipeline.from_pretrained(
                settings.flux_repo,
                revision=settings.flux_revision,
                torch_dtype=dtype,
                local_files_only=settings.offline,
            )
            if self._device.type == "cuda" and settings.flux_cpu_offload:
                pipe.enable_model_cpu_offload(gpu_id=self._device.index or 0, device="cuda")
            else:
                pipe.to(self._device)
        pipe.set_progress_bar_config(disable=True)
        self._pipe: Any = pipe
        self._torch = torch
        log.info(
            "flux loaded",
            extra={"repo": settings.flux_repo, "revision": settings.flux_revision[:12], "offload": settings.flux_cpu_offload},
        )

    def generate(self, prompt: str, width: int, height: int, seed: int) -> Image.Image:
        if self._pipe is None:
            raise PipelineError("generator is closed")
        torch = self._torch
        generator = torch.Generator(device=self._device).manual_seed(seed)
        with translate_oom(), torch.inference_mode():
            out = self._pipe(
                prompt=prompt,
                height=height,
                width=width,
                num_inference_steps=self._steps,
                guidance_scale=self._guidance,
                generator=generator,
                output_type="pil",
            )
        image: Image.Image = out.images[0]
        if image.size != (width, height):
            image = image.resize((width, height), Image.Resampling.LANCZOS)
        return image.convert("RGB")

    def close(self) -> None:
        pipe, self._pipe = self._pipe, None
        if pipe is None:
            return
        try:
            # Drops accelerate's offload hooks, which keep references to every component.
            pipe.remove_all_hooks()
        except Exception:
            log.warning("flux: remove_all_hooks failed", exc_info=True)
        del pipe
