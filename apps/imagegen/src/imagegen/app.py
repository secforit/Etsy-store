"""imagegen sidecar HTTP API (contract: docs/BUILD_SPEC.md "Sidecar API", client: packages/core/src/integrations/imagegen.ts).

    POST /generate  JSON {prompt, width, height, seed?, transparent} -> image/png + header x-seed
    POST /upscale   body image/png, query factor=2|4                 -> image/png
    POST /unload                                                     -> 204 (all models dropped, VRAM returned)
    GET  /healthz                                                    -> {"ok": true, "loaded": [...], "busy": bool}

Every route requires `Authorization: Bearer <IMAGEGEN_TOKEN>` (security.GuardMiddleware). GPU work is serialised by
runner.GpuRunner. Errors are JSON {"error": code, ...}; details never include request content or file paths.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Annotated, Any, TypeVar

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import (
    MAX_IMAGE_SIDE,
    MAX_JSON_BYTES,
    MAX_PROMPT_CHARS,
    MAX_SEED,
    MAX_SIDE,
    MAX_UPLOAD_BYTES,
    MIN_SIDE,
    SIDE_MULTIPLE,
    Settings,
)
from .imaging import (
    ImageTooLargeError,
    InvalidImageError,
    build_prompt,
    clean_prompt,
    compose_transparent,
    decode_png,
    encode_png,
    png_size,
    upscale_image,
)
from .interfaces import GpuOutOfMemoryError, ModelUnavailableError, PipelineError
from .models import ModelManager, PipelineFactories
from .runner import GpuBusyError, GpuRunner
from .security import SECURITY_HEADERS, BodyTooLargeError, GuardMiddleware

log = logging.getLogger("imagegen.api")

T = TypeVar("T")

Side = Annotated[int, Field(ge=MIN_SIDE, le=MAX_SIDE, multiple_of=SIDE_MULTIPLE)]


class GenerateRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    prompt: Annotated[str, Field(min_length=1, max_length=MAX_PROMPT_CHARS)]
    width: Side
    height: Side
    seed: Annotated[int, Field(ge=0, le=MAX_SEED)] | None = None
    transparent: bool


class ApiError(Exception):
    def __init__(self, status: int, code: str, retry_after: int | None = None, **extra: Any) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.retry_after = retry_after
        self.extra = extra


def _error_response(e: BaseException) -> JSONResponse:
    if isinstance(e, ApiError):
        status, code, retry_after, extra = e.status, e.code, e.retry_after, e.extra
    elif isinstance(e, BodyTooLargeError):
        status, code, retry_after, extra = 413, "body_too_large", None, {}
    elif isinstance(e, GpuBusyError):
        status, code, retry_after, extra = 503, "busy", 10, {}
    elif isinstance(e, GpuOutOfMemoryError):
        status, code, retry_after, extra = 503, "gpu_out_of_memory", 5, {}
    elif isinstance(e, ModelUnavailableError):
        status, code, retry_after, extra = 503, "model_unavailable", 30, {}
    elif isinstance(e, InvalidImageError):
        status, code, retry_after, extra = 400, "invalid_png", None, {}
    elif isinstance(e, ImageTooLargeError):
        status, code, retry_after, extra = 422, "image_too_large", None, {"max_side": MAX_IMAGE_SIDE}
    else:
        status, code, retry_after, extra = 500, "internal_error", None, {}
    if status >= 500:
        if code == "internal_error":
            log.error("request failed", exc_info=e)
        else:
            log.warning("request failed", extra={"error": code, "reason": str(e)[:200]})
    headers = {k.decode(): v.decode() for k, v in SECURITY_HEADERS}
    if retry_after is not None:
        headers["retry-after"] = str(retry_after)
    return JSONResponse({"error": code, **extra}, status_code=status, headers=headers)


def _require_content_type(request: Request, expected: str) -> None:
    value = request.headers.get("content-type", "")
    if value.split(";", 1)[0].strip().lower() != expected:
        raise ApiError(415, "unsupported_media_type", expected=expected)


async def _read_body(request: Request) -> bytes:
    try:
        return await request.body()
    except BodyTooLargeError:
        raise ApiError(413, "body_too_large") from None


def _parse_generate(body: bytes) -> GenerateRequest:
    try:
        req = GenerateRequest.model_validate_json(body)
    except ValidationError as e:
        errors = e.errors(include_url=False, include_input=False, include_context=False)
        if any(err["type"] == "json_invalid" for err in errors):
            raise ApiError(400, "invalid_json") from None
        details = [{"loc": [str(p) for p in err["loc"]], "msg": err["msg"]} for err in errors][:10]
        raise ApiError(422, "invalid_request", details=details) from None
    if not clean_prompt(req.prompt):
        raise ApiError(422, "invalid_request", details=[{"loc": ["prompt"], "msg": "prompt is empty"}])
    return req


def _parse_factor(request: Request) -> int:
    values = request.query_params.getlist("factor")
    if len(values) != 1 or values[0] not in ("2", "4"):
        raise ApiError(422, "invalid_request", details=[{"loc": ["query", "factor"], "msg": "factor must be 2 or 4"}])
    return int(values[0])


def create_app(settings: Settings, factories: PipelineFactories | None = None) -> FastAPI:
    if factories is None:
        from .real import real_factories

        factories = real_factories(settings)
    manager = ModelManager(factories)
    runner = GpuRunner(queue_timeout_s=settings.queue_timeout_s)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        await runner.start()
        try:
            yield
        finally:
            busy = runner.busy
            await runner.stop()
            if not busy:
                await asyncio.to_thread(manager.unload_all)

    app = FastAPI(
        title="imagegen",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
        # Nothing leaves this container: no OpenTelemetry auto-configuration or exporters.
        telemetry={"tracing": False, "metrics": False, "logs": False, "auto_configure": False},
    )
    app.state.manager = manager
    app.state.runner = runner
    app.add_middleware(
        GuardMiddleware,
        token=settings.token,
        body_limits={"/generate": MAX_JSON_BYTES, "/upscale": MAX_UPLOAD_BYTES},
        default_limit=4096,
    )

    async def on_gpu(fn: Callable[[], T]) -> T:
        result: T = await runner.run(lambda: manager.run_guarded(fn))
        return result

    @app.get("/healthz")
    async def healthz() -> JSONResponse:
        return JSONResponse({"ok": True, "loaded": manager.loaded(), "busy": runner.busy})

    @app.post("/generate")
    async def generate(request: Request) -> Response:
        started = time.monotonic()
        try:
            _require_content_type(request, "application/json")
            req = _parse_generate(await _read_body(request))
            prompt = build_prompt(req.prompt, req.transparent)
            seed = req.seed if req.seed is not None else secrets.randbelow(2**32)
            width, height, transparent = req.width, req.height, req.transparent

            def job() -> bytes:
                image = manager.generator().generate(prompt, width, height, seed)
                if image.size != (width, height):
                    raise PipelineError(f"generator returned {image.size}, expected {(width, height)}")
                if transparent:
                    mask = manager.matting().alpha(image)
                    image = compose_transparent(image, mask)
                return encode_png(image)

            png = await on_gpu(job)
        except Exception as e:
            return _error_response(e)
        log.info(
            "generate",
            extra={
                "width": width,
                "height": height,
                "transparent": transparent,
                "seed": seed,
                "prompt_chars": len(prompt),
                "ms": round((time.monotonic() - started) * 1000),
            },
        )
        return Response(png, media_type="image/png", headers={"x-seed": str(seed)})

    @app.post("/upscale")
    async def upscale(request: Request) -> Response:
        started = time.monotonic()
        try:
            factor = _parse_factor(request)
            _require_content_type(request, "image/png")
            body = await _read_body(request)
            if not body:
                raise ApiError(400, "invalid_png")
            # Output must stay within MAX_IMAGE_SIDE, so the input limit depends on the factor.
            max_in = MAX_IMAGE_SIDE // factor
            in_w, in_h = png_size(body, max_side=max_in, max_pixels=max_in * max_in)

            def job() -> bytes:
                image = decode_png(body, max_side=max_in, max_pixels=max_in * max_in)
                return encode_png(upscale_image(manager.upscaler(), image, factor))

            png = await on_gpu(job)
        except Exception as e:
            return _error_response(e)
        log.info(
            "upscale",
            extra={"width": in_w, "height": in_h, "factor": factor, "ms": round((time.monotonic() - started) * 1000)},
        )
        return Response(png, media_type="image/png")

    @app.post("/unload")
    async def unload() -> Response:
        try:
            await runner.run(manager.unload_all)
        except Exception as e:
            return _error_response(e)
        return Response(status_code=204)

    return app
