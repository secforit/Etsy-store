"""Tiled super-resolution (pure numpy; the model call is injected).

The image is split into a grid of core tiles. Each tile is run with `pad` pixels of context on every side (clamped to
the image), and only the core of the result is written back, so seams do not show (same scheme as Real-ESRGAN's
reference `tile`/`tile_pad` options). Peak VRAM depends on the tile size, not on the image size.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Tile:
    # Core region (written to the output), input pixel coordinates, end-exclusive.
    x0: int
    y0: int
    x1: int
    y1: int
    # Padded region (fed to the model).
    px0: int
    py0: int
    px1: int
    py1: int


def plan_tiles(width: int, height: int, tile: int, pad: int) -> list[Tile]:
    if width < 1 or height < 1:
        raise ValueError("empty image")
    if tile < 1 or pad < 0:
        raise ValueError("invalid tile settings")
    tiles: list[Tile] = []
    for y0 in range(0, height, tile):
        y1 = min(y0 + tile, height)
        for x0 in range(0, width, tile):
            x1 = min(x0 + tile, width)
            tiles.append(
                Tile(
                    x0=x0,
                    y0=y0,
                    x1=x1,
                    y1=y1,
                    px0=max(x0 - pad, 0),
                    py0=max(y0 - pad, 0),
                    px1=min(x1 + pad, width),
                    py1=min(y1 + pad, height),
                )
            )
    return tiles


#: Upscales one padded HxWx3 uint8 tile by `factor`; returns (H*factor)x(W*factor)x3 uint8.
TileFn = Callable[[np.ndarray, int], np.ndarray]


def upscale_tiled(rgb: np.ndarray, factor: int, tile: int, pad: int, run_tile: TileFn) -> np.ndarray:
    if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
        raise ValueError("expected an HxWx3 uint8 array")
    if factor < 1:
        raise ValueError("factor must be >= 1")
    height, width = rgb.shape[:2]
    out = np.empty((height * factor, width * factor, 3), dtype=np.uint8)
    for t in plan_tiles(width, height, tile, pad):
        patch = np.ascontiguousarray(rgb[t.py0 : t.py1, t.px0 : t.px1])
        result = run_tile(patch, factor)
        expected = ((t.py1 - t.py0) * factor, (t.px1 - t.px0) * factor, 3)
        if result.shape != expected or result.dtype != np.uint8:
            raise ValueError(f"tile function returned {result.shape} {result.dtype}, expected {expected} uint8")
        cy0, cx0 = (t.y0 - t.py0) * factor, (t.x0 - t.px0) * factor
        cy1, cx1 = cy0 + (t.y1 - t.y0) * factor, cx0 + (t.x1 - t.x0) * factor
        out[t.y0 * factor : t.y1 * factor, t.x0 * factor : t.x1 * factor] = result[cy0:cy1, cx0:cx1]
    return out
