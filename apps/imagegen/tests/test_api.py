from __future__ import annotations

import struct
import zlib

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from conftest import AUTH, TOKEN, Recorder, make_factories, make_settings, open_png, png_bytes
from imagegen.app import create_app
from imagegen.config import MAX_SEED, MAX_UPLOAD_BYTES
from imagegen.imaging import TRANSPARENT_SUFFIX
from imagegen.interfaces import ModelUnavailableError

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def gen_body(**overrides: object) -> dict:
    body: dict = {"prompt": "retro frog on a mushroom", "width": 512, "height": 768, "transparent": False, "seed": 7}
    body.update(overrides)
    return {k: v for k, v in body.items() if v is not ...}


# ------------------------------------------------------------------------------------------------------------- auth


@pytest.mark.parametrize(
    ("method", "path"),
    [("GET", "/healthz"), ("POST", "/generate"), ("POST", "/upscale?factor=4"), ("POST", "/unload"), ("GET", "/nope")],
)
@pytest.mark.parametrize(
    "header",
    [None, "Bearer wrong-token-0123456789abcdef0123", f"Basic {TOKEN}", f"Bearer {TOKEN}x", "Bearer ", f"{TOKEN}"],
)
def test_every_route_requires_the_bearer_token(client: TestClient, rec: Recorder, method: str, path: str, header: str | None) -> None:
    headers = {"Authorization": header} if header is not None else {}
    res = client.request(method, path, headers=headers, json=gen_body())
    assert res.status_code == 401
    assert res.headers["www-authenticate"] == "Bearer"
    assert res.json() == {"error": "unauthorized"}
    assert rec.created == [] and rec.calls == []


def test_scheme_is_case_insensitive(client: TestClient) -> None:
    assert client.get("/healthz", headers={"Authorization": f"bearer {TOKEN}"}).status_code == 200


def test_auth_is_checked_before_the_body_is_read(client: TestClient) -> None:
    res = client.post("/upscale?factor=4", content=b"\0" * (MAX_UPLOAD_BYTES + 1), headers={"content-type": "image/png"})
    assert res.status_code == 401


def test_no_docs_or_openapi(client: TestClient) -> None:
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path, headers=AUTH).status_code == 404


# ---------------------------------------------------------------------------------------------------------- healthz


def test_healthz_reports_loaded_models(client: TestClient) -> None:
    res = client.get("/healthz", headers=AUTH)
    assert res.status_code == 200
    assert res.json() == {"ok": True, "loaded": [], "busy": False}
    assert res.headers["cache-control"] == "no-store"
    assert res.headers["x-content-type-options"] == "nosniff"
    client.post("/generate", headers=AUTH, json=gen_body())
    assert client.get("/healthz", headers=AUTH).json()["loaded"] == ["flux2-klein-4b"]


# --------------------------------------------------------------------------------------------------------- generate


def test_generate_returns_png_of_requested_size_with_seed_header(client: TestClient, rec: Recorder) -> None:
    res = client.post("/generate", headers=AUTH, json=gen_body(prompt="  retro\tfrog \x00on a\nmushroom "))
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/png"
    assert res.headers["x-seed"] == "7"
    assert res.headers["cache-control"] == "no-store"
    assert res.content.startswith(PNG_SIG)
    img = open_png(res.content)
    assert img.size == (512, 768) and img.mode == "RGB"
    assert rec.calls == [("generate", "retro frog on a mushroom", 512, 768, 7)]
    assert rec.created == ["generator"]  # lazy: no matting, no upscaler
    assert rec.threads == {"gpu_0"}  # GPU work runs on the single dedicated thread


def test_generate_is_deterministic_for_a_seed(client: TestClient) -> None:
    a = client.post("/generate", headers=AUTH, json=gen_body(seed=42)).content
    b = client.post("/generate", headers=AUTH, json=gen_body(seed=42)).content
    c = client.post("/generate", headers=AUTH, json=gen_body(seed=43)).content
    assert a == b != c


def test_generate_without_seed_picks_one_and_reports_it(client: TestClient, rec: Recorder) -> None:
    res = client.post("/generate", headers=AUTH, json=gen_body(seed=...))
    assert res.status_code == 200
    seed = int(res.headers["x-seed"])
    assert 0 <= seed < 2**32
    assert rec.calls[0][4] == seed


def test_transparent_generation_is_matted_to_rgba(client: TestClient, rec: Recorder) -> None:
    res = client.post("/generate", headers=AUTH, json=gen_body(transparent=True, width=256, height=256))
    assert res.status_code == 200
    img = open_png(res.content)
    assert img.mode == "RGBA" and img.size == (256, 256)
    alpha = np.asarray(img.getchannel("A"))
    assert alpha[0, 0] == 0 and alpha[-1, -1] == 0  # white background removed
    assert alpha[128, 128] == 255  # subject kept
    prompt = rec.calls[0][1]
    assert prompt.startswith("retro frog on a mushroom. ") and prompt.endswith(TRANSPARENT_SUFFIX)
    assert rec.calls[1] == ("alpha", (256, 256))
    assert rec.created == ["generator", "matting"]


@pytest.mark.parametrize(
    ("overrides", "loc"),
    [
        ({"width": 500}, "width"),
        ({"width": 2064}, "width"),
        ({"height": 240}, "height"),
        ({"width": "512"}, "width"),  # strict: no string coercion
        ({"width": 512.0}, "width"),
        ({"prompt": ""}, "prompt"),
        ({"prompt": "x" * 2001}, "prompt"),
        ({"prompt": 5}, "prompt"),
        ({"seed": -1}, "seed"),
        ({"seed": MAX_SEED + 1}, "seed"),
        ({"transparent": "yes"}, "transparent"),
        ({"transparent": ...}, "transparent"),
        ({"style": "vector"}, "style"),  # unknown fields are rejected
    ],
)
def test_generate_validates_the_request(client: TestClient, rec: Recorder, overrides: dict, loc: str) -> None:
    res = client.post("/generate", headers=AUTH, json=gen_body(**overrides))
    assert res.status_code == 422
    body = res.json()
    assert body["error"] == "invalid_request"
    assert any(loc in d["loc"] for d in body["details"])
    assert all(set(d) == {"loc", "msg"} for d in body["details"])  # no "input" echo
    assert "x" * 50 not in res.text and "vector" not in res.text  # request content is never echoed
    assert rec.created == []


def test_generate_rejects_a_whitespace_only_prompt(client: TestClient) -> None:
    res = client.post("/generate", headers=AUTH, json=gen_body(prompt=" \n\t\x01 "))
    assert res.status_code == 422


def test_generate_accepts_the_prompt_limit_exactly(client: TestClient) -> None:
    assert client.post("/generate", headers=AUTH, json=gen_body(prompt="y" * 2000)).status_code == 200


def test_generate_rejects_bad_json_and_content_type(client: TestClient) -> None:
    res = client.post("/generate", headers={**AUTH, "content-type": "application/json"}, content=b"{nope")
    assert res.status_code == 400 and res.json() == {"error": "invalid_json"}
    res = client.post("/generate", headers={**AUTH, "content-type": "text/plain"}, content=b"{}")
    assert res.status_code == 415


def test_generate_rejects_an_oversized_body(client: TestClient) -> None:
    res = client.post("/generate", headers={**AUTH, "content-type": "application/json"}, content=b" " * (64 * 1024 + 1))
    assert res.status_code == 413
    assert res.json()["error"] == "body_too_large"


def test_model_load_failure_is_a_503_without_details(rec: Recorder) -> None:
    rec.fail_load["generator"] = OSError("/models/secret/path missing")
    with TestClient(create_app(make_settings(), make_factories(rec))) as client:
        res = client.post("/generate", headers=AUTH, json=gen_body())
    assert res.status_code == 503
    assert res.headers["retry-after"] == "30"
    assert res.json() == {"error": "model_unavailable"}
    assert "secret" not in res.text


def test_pipeline_unavailable_error_passes_through(rec: Recorder) -> None:
    rec.fail_load["generator"] = ModelUnavailableError("offline and weights missing")
    with TestClient(create_app(make_settings(), make_factories(rec))) as client:
        res = client.post("/generate", headers=AUTH, json=gen_body())
    assert res.status_code == 503 and res.json() == {"error": "model_unavailable"}


def test_out_of_memory_unloads_everything_and_the_retry_works(client: TestClient, rec: Recorder) -> None:
    client.post("/upscale?factor=2", headers={**AUTH, "content-type": "image/png"}, content=png_bytes(Image.new("RGB", (8, 8))))
    rec.oom_once.add("generate")
    res = client.post("/generate", headers=AUTH, json=gen_body())
    assert res.status_code == 503
    assert res.json() == {"error": "gpu_out_of_memory"}
    assert res.headers["retry-after"] == "5"
    assert sorted(rec.closed) == ["flux2-klein-4b", "realesrgan-x4plus"]
    assert rec.frees == 1
    assert client.get("/healthz", headers=AUTH).json()["loaded"] == []
    assert client.post("/generate", headers=AUTH, json=gen_body()).status_code == 200


def test_unexpected_errors_are_a_generic_500(client: TestClient, rec: Recorder) -> None:
    def boom() -> None:
        raise RuntimeError("internal detail /models/x")

    rec.gen_hook = boom
    res = client.post("/generate", headers=AUTH, json=gen_body())
    assert res.status_code == 500
    assert res.json() == {"error": "internal_error"}


# ---------------------------------------------------------------------------------------------------------- upscale


def post_upscale(client: TestClient, data: bytes, factor: str = "4", content_type: str = "image/png"):
    return client.post(f"/upscale?factor={factor}", headers={**AUTH, "content-type": content_type}, content=data)


@pytest.mark.parametrize("factor", [2, 4])
def test_upscale_rgb(client: TestClient, rec: Recorder, factor: int) -> None:
    src = Image.new("RGB", (64, 48), (10, 20, 30))
    src.putpixel((0, 0), (250, 0, 0))
    res = post_upscale(client, png_bytes(src), str(factor))
    assert res.status_code == 200 and res.headers["content-type"] == "image/png"
    out = open_png(res.content)
    assert out.size == (64 * factor, 48 * factor) and out.mode == "RGB"
    assert out.getpixel((factor - 1, factor - 1)) == (250, 0, 0)
    assert rec.calls == [("upscale", "RGB", (64, 48), factor)]


def test_upscale_keeps_and_upscales_alpha(client: TestClient, rec: Recorder) -> None:
    src = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    src.paste((200, 100, 50, 255), (8, 8, 24, 24))
    src.putpixel((8, 7), (200, 100, 50, 128))
    out = open_png(post_upscale(client, png_bytes(src)).content)
    assert out.mode == "RGBA" and out.size == (128, 128)
    a = np.asarray(out.getchannel("A"))
    assert a[0, 0] == 0 and a[64, 64] == 255 and a[29, 33] in range(120, 136)
    assert [c[1] for c in rec.calls] == ["RGB", "RGB"]  # colour, then the matte as grey RGB


def test_upscale_opaque_alpha_runs_the_model_once(client: TestClient, rec: Recorder) -> None:
    out = open_png(post_upscale(client, png_bytes(Image.new("RGBA", (16, 16), (1, 2, 3, 255)))).content)
    assert out.mode == "RGBA" and np.asarray(out.getchannel("A")).min() == 255
    assert len(rec.calls) == 1


def test_upscale_handles_16_bit_grey_and_palette_pngs(client: TestClient) -> None:
    grey16 = Image.fromarray(np.full((10, 12), 40000, dtype=np.uint16))
    out = open_png(post_upscale(client, png_bytes(grey16), "2").content)
    assert out.mode == "RGB" and out.size == (24, 20)
    assert np.asarray(out)[0, 0, 0] == round(40000 / 65535 * 255)
    pal = Image.new("P", (8, 8), 0)
    pal.putpalette([0, 0, 0, 255, 0, 0])
    pal.info["transparency"] = 0
    out = open_png(post_upscale(client, png_bytes(pal)).content)
    assert out.mode == "RGBA"


@pytest.mark.parametrize("query", ["factor=3", "factor=", "factor=4&factor=2", "", "factor=x4"])
def test_upscale_validates_factor(client: TestClient, rec: Recorder, query: str) -> None:
    res = client.post(f"/upscale?{query}", headers={**AUTH, "content-type": "image/png"}, content=png_bytes(Image.new("RGB", (4, 4))))
    assert res.status_code == 422 and res.json()["error"] == "invalid_request"
    assert rec.created == []


def test_upscale_requires_png_content(client: TestClient, rec: Recorder) -> None:
    img = Image.new("RGB", (8, 8))
    assert post_upscale(client, png_bytes(img), content_type="image/jpeg").status_code == 415
    assert post_upscale(client, b"<html>not a png</html>").json() == {"error": "invalid_png"}
    assert post_upscale(client, b"").status_code == 400
    assert post_upscale(client, png_bytes(img)[:-30]).status_code == 400  # truncated
    import io

    jpg = io.BytesIO()
    img.save(jpg, format="JPEG")
    assert post_upscale(client, jpg.getvalue()).status_code == 400
    assert rec.created == []


def test_upscale_rejects_more_than_50_mb(client: TestClient) -> None:
    res = post_upscale(client, b"\0" * (MAX_UPLOAD_BYTES + 1))
    assert res.status_code == 413 and res.json()["error"] == "body_too_large"


def test_upscale_limits_output_to_12000_px(client: TestClient, rec: Recorder) -> None:
    ok = post_upscale(client, png_bytes(Image.new("RGB", (3000, 1))), "4")
    assert ok.status_code == 200
    too_big = post_upscale(client, png_bytes(Image.new("RGB", (3001, 1))), "4")
    assert too_big.status_code == 422 and too_big.json()["error"] == "image_too_large"
    assert post_upscale(client, png_bytes(Image.new("RGB", (6001, 1))), "2").status_code == 422


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def test_upscale_rejects_decompression_bombs_from_the_header(client: TestClient, rec: Recorder) -> None:
    ihdr = struct.pack(">IIBBBBB", 50_000, 50_000, 8, 2, 0, 0, 0)
    bomb = PNG_SIG + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(b"\0" * 1024)) + _chunk(b"IEND", b"")
    res = post_upscale(client, bomb)
    assert res.status_code == 422 and res.json()["error"] == "image_too_large"
    assert rec.created == []


# ----------------------------------------------------------------------------------------------------------- unload


def test_unload_frees_every_model(client: TestClient, rec: Recorder) -> None:
    client.post("/generate", headers=AUTH, json=gen_body(transparent=True, width=256, height=256))
    post_upscale(client, png_bytes(Image.new("RGB", (8, 8))))
    assert sorted(client.get("/healthz", headers=AUTH).json()["loaded"]) == ["birefnet", "flux2-klein-4b", "realesrgan-x4plus"]
    res = client.post("/unload", headers=AUTH)
    assert res.status_code == 204 and res.content == b""
    assert sorted(rec.closed) == ["birefnet", "flux2-klein-4b", "realesrgan-x4plus"]
    assert rec.frees == 1
    assert client.get("/healthz", headers=AUTH).json()["loaded"] == []
    # lazy reload after an unload
    assert client.post("/generate", headers=AUTH, json=gen_body()).status_code == 200
    assert rec.created.count("generator") == 2


def test_unload_with_nothing_loaded(client: TestClient, rec: Recorder) -> None:
    assert client.post("/unload", headers=AUTH).status_code == 204
    assert rec.closed == []


def test_unload_rejects_a_body(client: TestClient) -> None:
    res = client.post("/unload", headers={**AUTH, "content-type": "application/octet-stream"}, content=b"x" * 5000)
    assert res.status_code == 413


def test_shutdown_unloads_models(rec: Recorder) -> None:
    with TestClient(create_app(make_settings(), make_factories(rec))) as client:
        client.post("/generate", headers=AUTH, json=gen_body())
    assert rec.closed == ["flux2-klein-4b"]
