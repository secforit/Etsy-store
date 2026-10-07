"""Fake pipelines: deterministic, CPU-only, no torch. They record calls so tests can check laziness and unloading."""

from __future__ import annotations

import io
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from imagegen.app import create_app
from imagegen.config import Settings
from imagegen.interfaces import GpuOutOfMemoryError
from imagegen.models import PipelineFactories

TOKEN = "test-token-0123456789abcdef0123456789"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@dataclass
class Recorder:
    created: list[str] = field(default_factory=list)
    closed: list[str] = field(default_factory=list)
    calls: list[tuple] = field(default_factory=list)
    frees: int = 0
    gen_hook: Callable[[], None] | None = None
    fail_load: dict[str, BaseException] = field(default_factory=dict)
    oom_once: set[str] = field(default_factory=set)
    threads: set[str] = field(default_factory=set)


class FakeGenerator:
    name = "flux2-klein-4b"

    def __init__(self, rec: Recorder) -> None:
        self.rec = rec

    def generate(self, prompt: str, width: int, height: int, seed: int) -> Image.Image:
        self.rec.calls.append(("generate", prompt, width, height, seed))
        self.rec.threads.add(threading.current_thread().name)
        if self.rec.gen_hook:
            self.rec.gen_hook()
        if "generate" in self.rec.oom_once:
            self.rec.oom_once.discard("generate")
            raise GpuOutOfMemoryError("CUDA out of memory")
        rng = np.random.default_rng(seed)
        color = tuple(int(c) for c in rng.integers(0, 200, 3))
        img = Image.new("RGB", (width, height), (255, 255, 255))
        # a centred square "subject" on white, so the fake matte has something to cut out
        img.paste(color, (width // 4, height // 4, 3 * width // 4, 3 * height // 4))
        return img

    def close(self) -> None:
        self.rec.closed.append(self.name)


class FakeMatting:
    name = "birefnet"

    def __init__(self, rec: Recorder) -> None:
        self.rec = rec

    def alpha(self, image: Image.Image) -> Image.Image:
        self.rec.calls.append(("alpha", image.size))
        arr = np.asarray(image.convert("RGB")).astype(np.int32)
        fg = (arr.sum(axis=2) < 3 * 250).astype(np.uint8) * 255
        return Image.fromarray(fg)

    def close(self) -> None:
        self.rec.closed.append(self.name)


class FakeUpscaler:
    name = "realesrgan-x4plus"

    def __init__(self, rec: Recorder) -> None:
        self.rec = rec

    def upscale(self, image: Image.Image, factor: int) -> Image.Image:
        self.rec.calls.append(("upscale", image.mode, image.size, factor))
        return image.resize((image.width * factor, image.height * factor), Image.Resampling.NEAREST)

    def close(self) -> None:
        self.rec.closed.append(self.name)


def make_factories(rec: Recorder) -> PipelineFactories:
    def build(name: str, cls: type) -> Callable[[], object]:
        def factory() -> object:
            if name in rec.fail_load:
                raise rec.fail_load[name]
            rec.created.append(name)
            return cls(rec)

        return factory

    def free() -> None:
        rec.frees += 1

    return PipelineFactories(
        generator=build("generator", FakeGenerator),  # type: ignore[arg-type]
        matting=build("matting", FakeMatting),  # type: ignore[arg-type]
        upscaler=build("upscaler", FakeUpscaler),  # type: ignore[arg-type]
        free_memory=free,
    )


def make_settings(**overrides: object) -> Settings:
    return Settings(token=TOKEN, **overrides)  # type: ignore[arg-type]


@pytest.fixture
def rec() -> Recorder:
    return Recorder()


@pytest.fixture
def client(rec: Recorder) -> Iterator[TestClient]:
    app = create_app(make_settings(), make_factories(rec))
    with TestClient(app) as c:
        yield c


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def open_png(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img
