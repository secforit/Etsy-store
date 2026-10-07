from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from conftest import png_bytes
from imagegen.imaging import (
    TRANSPARENT_SUFFIX,
    ImageTooLargeError,
    InvalidImageError,
    _box_mean,
    build_prompt,
    clean_alpha,
    clean_prompt,
    compose_transparent,
    decode_png,
    normalise_mode,
    png_size,
)
from imagegen.tiling import plan_tiles, upscale_tiled


def test_clean_and_build_prompt() -> None:
    assert clean_prompt("  a\tb\n\x00c  ") == "a b c"
    assert build_prompt("a cat.", transparent=False) == "a cat."
    assert build_prompt("a cat. ", transparent=True) == f"a cat. {TRANSPARENT_SUFFIX}"


def test_decode_png_checks_signature_size_and_integrity() -> None:
    data = png_bytes(Image.new("RGB", (40, 30)))
    assert png_size(data) == (40, 30)
    assert decode_png(data).size == (40, 30)
    with pytest.raises(InvalidImageError):
        decode_png(b"GIF89a....")
    with pytest.raises(InvalidImageError):
        decode_png(data[:40])
    with pytest.raises(ImageTooLargeError):
        decode_png(data, max_side=39, max_pixels=10**9)
    with pytest.raises(ImageTooLargeError):
        png_size(data, max_side=100, max_pixels=40 * 30 - 1)


def test_box_mean_matches_a_naive_window_mean() -> None:
    rng = np.random.default_rng(0)
    a = rng.random((9, 13))
    k = 4
    lo, hi = k // 2, k - k // 2 - 1
    naive = np.empty_like(a)
    for y in range(a.shape[0]):
        for x in range(a.shape[1]):
            naive[y, x] = a[max(y - lo, 0) : y + hi + 1, max(x - lo, 0) : x + hi + 1].mean()
    np.testing.assert_allclose(_box_mean(a, k), naive, rtol=1e-12)
    rgb = rng.random((9, 13, 3))
    np.testing.assert_allclose(_box_mean(rgb, k)[:, :, 1], _box_mean(rgb[:, :, 1], k), rtol=1e-12)


def test_clean_alpha_snaps_near_values() -> None:
    mask = Image.fromarray(np.array([[0, 5, 8, 9, 128, 246, 247, 255]], dtype=np.uint8))
    assert np.asarray(clean_alpha(mask)).tolist() == [[0, 0, 0, 9, 128, 246, 255, 255]]


def test_compose_transparent_removes_the_white_halo() -> None:
    # dark-red subject on white with a 50% alpha edge pixel that the generator blended with white
    rgb = np.full((64, 64, 3), 255, dtype=np.uint8)
    rgb[16:48, 16:48] = (120, 10, 10)
    rgb[16:48, 15] = (188, 132, 132)  # 50/50 mix of subject and white
    alpha = np.zeros((64, 64), dtype=np.uint8)
    alpha[16:48, 16:48] = 255
    alpha[16:48, 15] = 128
    out = compose_transparent(Image.fromarray(rgb), Image.fromarray(alpha))
    assert out.mode == "RGBA" and out.size == (64, 64)
    arr = np.asarray(out)
    assert arr[32, 32, 3] == 255 and arr[0, 0, 3] == 0 and arr[32, 15, 3] == 128
    edge = arr[32, 15, :3].astype(int)
    assert edge[1] < 132 - 40  # much closer to the subject colour than the white-blended input
    assert abs(int(arr[32, 32, 0]) - 120) <= 2  # interior unchanged


def test_compose_transparent_resizes_a_smaller_mask() -> None:
    out = compose_transparent(Image.new("RGB", (64, 32), (0, 0, 0)), Image.new("L", (32, 16), 255))
    assert out.size == (64, 32) and np.asarray(out.getchannel("A")).min() == 255


@pytest.mark.parametrize(
    ("mode", "expected"),
    [("RGB", "RGB"), ("RGBA", "RGBA"), ("L", "RGB"), ("LA", "RGBA"), ("1", "RGB"), ("P", "RGB"), ("I", "RGB"), ("CMYK", "RGB")],
)
def test_normalise_mode(mode: str, expected: str) -> None:
    assert normalise_mode(Image.new(mode, (4, 4))).mode == expected


# ------------------------------------------------------------------------------------------------------------ tiling


@pytest.mark.parametrize(("w", "h", "tile", "pad"), [(1, 1, 4, 2), (10, 7, 4, 0), (10, 7, 4, 3), (512, 300, 128, 16), (5, 9, 64, 8)])
def test_plan_tiles_partitions_the_image(w: int, h: int, tile: int, pad: int) -> None:
    cover = np.zeros((h, w), dtype=int)
    for t in plan_tiles(w, h, tile, pad):
        cover[t.y0 : t.y1, t.x0 : t.x1] += 1
        assert 0 <= t.px0 <= t.x0 < t.x1 <= t.px1 <= w
        assert 0 <= t.py0 <= t.y0 < t.y1 <= t.py1 <= h
        assert t.x0 - t.px0 <= pad and t.px1 - t.x1 <= pad
        assert t.x1 - t.x0 <= tile and t.y1 - t.y0 <= tile
    assert (cover == 1).all()


def nearest(patch: np.ndarray, factor: int) -> np.ndarray:
    return np.repeat(np.repeat(patch, factor, axis=0), factor, axis=1)


@pytest.mark.parametrize("factor", [2, 4])
@pytest.mark.parametrize(("w", "h", "tile", "pad"), [(37, 23, 8, 3), (16, 16, 16, 0), (50, 3, 7, 5)])
def test_upscale_tiled_stitches_seamlessly(factor: int, w: int, h: int, tile: int, pad: int) -> None:
    rgb = np.random.default_rng(1).integers(0, 256, (h, w, 3), dtype=np.uint8)
    out = upscale_tiled(rgb, factor, tile, pad, nearest)
    np.testing.assert_array_equal(out, nearest(rgb, factor))


def test_upscale_tiled_context_is_used() -> None:
    # A model that depends on context: output = tile mean. With padding, cores see their neighbours.
    seen: list[tuple[int, int]] = []

    def run_tile(patch: np.ndarray, factor: int) -> np.ndarray:
        seen.append(patch.shape[:2])
        return nearest(patch, factor)

    upscale_tiled(np.zeros((20, 20, 3), dtype=np.uint8), 4, 10, 4, run_tile)
    assert seen == [(14, 14)] * 4


def test_upscale_tiled_rejects_bad_tile_output() -> None:
    with pytest.raises(ValueError):
        upscale_tiled(np.zeros((8, 8, 3), dtype=np.uint8), 4, 4, 0, lambda p, f: p)
    with pytest.raises(ValueError):
        upscale_tiled(np.zeros((8, 8), dtype=np.uint8), 4, 4, 0, nearest)


def test_json_logs_hide_uvicorn_noise_and_healthz_probes() -> None:
    import json
    import logging

    from imagegen.logs import JsonFormatter, _QuietHealthChecks

    rec = logging.LogRecord("uvicorn.access", logging.INFO, "x", 0, '%s - "%s %s HTTP/%s" %d', ("1.2.3.4:5", "GET", "/healthz", "1.1", 200), None)
    assert not _QuietHealthChecks().filter(rec)
    rec.args = ("1.2.3.4:5", "GET", "/healthz", "1.1", 401)
    assert _QuietHealthChecks().filter(rec)
    rec.color_message = "\x1b[36m..."
    rec.width = 512
    out = json.loads(JsonFormatter().format(rec))
    assert out["width"] == 512 and "color_message" not in out and out["logger"] == "uvicorn.access"
