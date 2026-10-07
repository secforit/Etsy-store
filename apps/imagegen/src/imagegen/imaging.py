"""Pillow/numpy helpers: safe PNG decoding, PNG encoding, alpha compositing and the x2/x4 upscale wrapper.

No torch here: everything in this module is covered by the unit tests.
"""

from __future__ import annotations

import io
import unicodedata

import numpy as np
from PIL import Image, UnidentifiedImageError

from .config import MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE
from .interfaces import Upscaler

# Decompression-bomb guard for every Pillow decode in this process. Pillow warns above this and raises above 2x;
# decode_png() additionally rejects anything above it before pixel data is touched.
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

#: Appended for transparent output: the subject is generated on plain white, then BiRefNet cuts it out.
TRANSPARENT_SUFFIX = "Isolated subject centered on a plain pure white background, no shadow, no frame, no border."


class InvalidImageError(ValueError):
    """Not a decodable PNG."""


class ImageTooLargeError(ValueError):
    """Pixel dimensions above the configured limits."""


def clean_prompt(prompt: str) -> str:
    """Control characters become spaces; whitespace is collapsed."""
    chars = (" " if unicodedata.category(c) == "Cc" else c for c in prompt)
    return " ".join("".join(chars).split())


def build_prompt(prompt: str, transparent: bool) -> str:
    base = clean_prompt(prompt)
    if not transparent:
        return base
    return f"{base.rstrip(' .')}. {TRANSPARENT_SUFFIX}"


def png_size(data: bytes, max_side: int = MAX_IMAGE_SIDE, max_pixels: int = MAX_IMAGE_PIXELS) -> tuple[int, int]:
    """Validates the PNG signature and header without decoding pixels. Returns (width, height)."""
    img = _open_png(data, max_side, max_pixels)
    try:
        return img.size
    finally:
        img.close()


def decode_png(data: bytes, max_side: int = MAX_IMAGE_SIDE, max_pixels: int = MAX_IMAGE_PIXELS) -> Image.Image:
    """Decodes a PNG (first frame only) after checking signature, dimensions and pixel count."""
    img = _open_png(data, max_side, max_pixels)
    try:
        img.load()
    except Image.DecompressionBombError as e:
        raise ImageTooLargeError("image exceeds the pixel limit") from e
    except (OSError, SyntaxError, ValueError, EOFError) as e:
        raise InvalidImageError("corrupt or truncated PNG") from e
    return img


def _open_png(data: bytes, max_side: int, max_pixels: int) -> Image.Image:
    if not data.startswith(PNG_MAGIC):
        raise InvalidImageError("body is not a PNG (bad signature)")
    try:
        img = Image.open(io.BytesIO(data), formats=["PNG"])
    except Image.DecompressionBombError as e:
        raise ImageTooLargeError("image exceeds the pixel limit") from e
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, EOFError) as e:
        raise InvalidImageError("unreadable PNG header") from e
    w, h = img.size
    if w < 1 or h < 1:
        img.close()
        raise InvalidImageError("empty image")
    if w > max_side or h > max_side or w * h > max_pixels:
        img.close()
        raise ImageTooLargeError(f"image is {w}x{h}; limit is {max_side} px per side")
    return img


def encode_png(img: Image.Image) -> bytes:
    """PNG without metadata chunks (Pillow writes none unless asked)."""
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=6)
    return buf.getvalue()


def normalise_mode(img: Image.Image) -> Image.Image:
    """Any PNG mode -> 8-bit 'RGB' or 'RGBA' (alpha kept when the file has any transparency)."""
    if img.mode in ("RGB", "RGBA"):
        return img
    if img.mode in ("I", "I;16", "I;16B", "I;16L", "I;16N", "F"):
        arr = np.asarray(img, dtype=np.float64)
        peak = float(arr.max()) if arr.size else 0.0
        if peak > 255.0:
            arr = arr / (65535.0 if peak <= 65535.0 else peak) * 255.0
        gray = Image.fromarray(np.clip(np.rint(arr), 0, 255).astype(np.uint8))
        return gray.convert("RGB")
    if img.mode in ("LA", "La", "PA", "RGBa") or "transparency" in img.info:
        return img.convert("RGBA")
    return img.convert("RGB")


def _box_mean(a: np.ndarray, k: int) -> np.ndarray:
    """Mean over a k x k window (edge windows are shrunk, not padded). Separable, via cumulative sums."""
    out = a.astype(np.float64, copy=False)
    for axis in (0, 1):
        n = out.shape[axis]
        lo, hi = k // 2, k - k // 2 - 1
        csum = np.cumsum(out, axis=axis)
        pad_shape = list(out.shape)
        pad_shape[axis] = 1
        csum = np.concatenate([np.zeros(pad_shape), csum], axis=axis)
        idx = np.arange(n)
        start = np.clip(idx - lo, 0, n)
        end = np.clip(idx + hi + 1, 0, n)
        total = np.take(csum, end, axis=axis) - np.take(csum, start, axis=axis)
        count_shape = [1] * out.ndim
        count_shape[axis] = n
        out = total / (end - start).reshape(count_shape)
    return out


def _fb_blur_fusion(image: np.ndarray, fg: np.ndarray, bg: np.ndarray, alpha: np.ndarray, r: int) -> tuple[np.ndarray, np.ndarray]:
    # Approximate fast foreground colour estimation (Germer et al.; github.com/Photoroom/fast-foreground-estimation),
    # the same "refine_foreground" step BiRefNet's reference handler uses.
    blurred_alpha = _box_mean(alpha, r)[:, :, None]
    a = alpha[:, :, None]
    blurred_f = _box_mean(fg * a, r) / (blurred_alpha + 1e-5)
    blurred_b = _box_mean(bg * (1.0 - a), r) / ((1.0 - blurred_alpha) + 1e-5)
    f = blurred_f + a * (image - a * blurred_f - (1.0 - a) * blurred_b)
    return np.clip(f, 0.0, 1.0), blurred_b


def estimate_foreground(rgb: Image.Image, mask: Image.Image, r: int = 90) -> Image.Image:
    """Removes the background colour (the white halo) from semi-transparent edge pixels."""
    image = np.asarray(rgb.convert("RGB"), dtype=np.float64) / 255.0
    alpha = np.asarray(mask.convert("L"), dtype=np.float64) / 255.0
    fg, blurred_bg = _fb_blur_fusion(image, image, image, alpha, r)
    fg, _ = _fb_blur_fusion(image, fg, blurred_bg, alpha, 6)
    return Image.fromarray(np.clip(np.rint(fg * 255.0), 0, 255).astype(np.uint8))


def clean_alpha(mask: Image.Image, low: int = 8, high: int = 247) -> Image.Image:
    """Snaps near-transparent to 0 and near-opaque to 255 so prints have few semi-transparent pixels."""
    a = np.asarray(mask.convert("L"), dtype=np.uint8).copy()
    a[a <= low] = 0
    a[a >= high] = 255
    return Image.fromarray(a)


def compose_transparent(rgb: Image.Image, mask: Image.Image) -> Image.Image:
    """RGB + matte -> RGBA with decontaminated edge colours."""
    rgb = rgb.convert("RGB")
    if mask.size != rgb.size:
        mask = mask.resize(rgb.size, Image.Resampling.BILINEAR)
    alpha = clean_alpha(mask)
    fg = estimate_foreground(rgb, alpha)
    out = fg.convert("RGBA")
    out.putalpha(alpha)
    return out


def upscale_image(upscaler: Upscaler, img: Image.Image, factor: int) -> Image.Image:
    """x2/x4 super-resolution of RGB, with the alpha channel (if any) upscaled by the same model."""
    if factor not in (2, 4):
        raise ValueError("factor must be 2 or 4")
    img = normalise_mode(img)
    target = (img.width * factor, img.height * factor)
    rgb = img.convert("RGB")
    out_rgb = _checked(upscaler.upscale(rgb, factor), target)
    if img.mode != "RGBA":
        return out_rgb
    alpha = img.getchannel("A")
    lo, hi = alpha.getextrema()
    if lo == hi:
        out_alpha = Image.new("L", target, lo)
    else:
        # Same approach as Real-ESRGAN's reference inference: the matte goes through the model as a grey image.
        grey = Image.merge("RGB", (alpha, alpha, alpha))
        out_alpha = _checked(upscaler.upscale(grey, factor), target).convert("L")
    out = out_rgb.convert("RGBA")
    out.putalpha(out_alpha)
    return out


def _checked(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    if img.size != size:
        # Defensive: an implementation must return exactly factor x the input.
        img = img.resize(size, Image.Resampling.LANCZOS)
    return img.convert("RGB")
