from __future__ import annotations

import hashlib
import io
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import TOKEN, make_settings
from imagegen import download, healthcheck
from imagegen.config import (
    BIREFNET_REVISION,
    ESRGAN_SHA256,
    FLUX_REPO,
    FLUX_REVISION,
    ConfigError,
    load_settings,
)
from imagegen.interfaces import ModelUnavailableError
from imagegen.security import token_matches
from imagegen.weights import ensure_esrgan_weights

# ------------------------------------------------------------------------------------------------------------ config


def test_defaults_are_the_pinned_commercial_models() -> None:
    s = load_settings({"IMAGEGEN_TOKEN": TOKEN})
    assert s.flux_repo == FLUX_REPO == "black-forest-labs/FLUX.2-klein-4B"
    assert s.flux_revision == FLUX_REVISION and len(FLUX_REVISION) == 40
    assert s.birefnet_repo == "ZhengPeng7/BiRefNet" and s.birefnet_revision == BIREFNET_REVISION
    assert s.esrgan_sha256 == ESRGAN_SHA256
    assert (s.flux_steps, s.flux_guidance, s.flux_cpu_offload) == (4, 1.0, True)
    assert s.port == 8000 and s.device == "cuda" and not s.offline
    assert s.esrgan_path == Path("/models/realesrgan/RealESRGAN_x4plus.pth")


def test_token_is_required_long_and_never_in_repr(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="IMAGEGEN_TOKEN"):
        load_settings({})
    with pytest.raises(ConfigError, match="at least 24"):
        load_settings({"IMAGEGEN_TOKEN": "short"})
    secret = tmp_path / "token"
    secret.write_text(TOKEN + "\n")
    s = load_settings({"IMAGEGEN_TOKEN_FILE": str(secret)})
    assert s.token == TOKEN
    assert TOKEN not in repr(s)
    with pytest.raises(ConfigError) as err:
        load_settings({"IMAGEGEN_TOKEN_FILE": str(tmp_path / "missing")})
    assert "missing" not in str(err.value)


@pytest.mark.parametrize(
    "repo", ["black-forest-labs/FLUX.1-dev", "black-forest-labs/FLUX.2-klein-9B", "Black-Forest-Labs/flux.2-klein-base-9b"]
)
def test_non_commercial_models_are_refused(repo: str) -> None:
    with pytest.raises(ConfigError, match="non-commercial"):
        load_settings({"IMAGEGEN_TOKEN": TOKEN, "IMAGEGEN_FLUX_REPO": repo})
    # The escape hatch for unreviewed models never unlocks a known non-commercial one.
    with pytest.raises(ConfigError, match="non-commercial"):
        load_settings({"IMAGEGEN_TOKEN": TOKEN, "IMAGEGEN_FLUX_REPO": repo, "IMAGEGEN_ALLOW_UNREVIEWED_MODEL": "1"})


@pytest.mark.parametrize(
    "env",
    [
        {"IMAGEGEN_FLUX_REPO": "some-user/FLUX.2-klein-9B-mirror"},  # mirror of a non-commercial model
        {"IMAGEGEN_FLUX_REVISION": "main"},  # floating revision of the approved repo
        {"IMAGEGEN_BIREFNET_REVISION": "main"},  # unreviewed trust_remote_code
        {"IMAGEGEN_BIREFNET_REPO": "someone/BiRefNet-fork"},
        {"IMAGEGEN_ESRGAN_SHA256": "0" * 64},  # other upscaler weights
    ],
)
def test_only_reviewed_model_pins_run(env: dict[str, str], caplog: pytest.LogCaptureFixture) -> None:
    with pytest.raises(ConfigError, match="unreviewed model"):
        load_settings({"IMAGEGEN_TOKEN": TOKEN, **env})
    with caplog.at_level("ERROR", logger="imagegen"):
        s = load_settings({"IMAGEGEN_TOKEN": TOKEN, "IMAGEGEN_ALLOW_UNREVIEWED_MODEL": "1", **env})
    assert s is not None
    assert any("UNREVIEWED" in r.getMessage() and r.levelname == "ERROR" for r in caplog.records)


def test_reviewed_pins_need_no_override_and_case_of_repo_does_not_matter(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level("ERROR", logger="imagegen"):
        s = load_settings({"IMAGEGEN_TOKEN": TOKEN, "IMAGEGEN_FLUX_REPO": FLUX_REPO.upper(), "IMAGEGEN_FLUX_REVISION": FLUX_REVISION})
    assert s.flux_repo == FLUX_REPO.upper()
    assert not caplog.records


@pytest.mark.parametrize(
    "env",
    [
        {"IMAGEGEN_PORT": "abc"},
        {"IMAGEGEN_PORT": "70000"},
        {"IMAGEGEN_UPSCALE_TILE": "8"},
        {"IMAGEGEN_DEVICE": "mps"},
        {"IMAGEGEN_OFFLINE": "maybe"},
        {"IMAGEGEN_ESRGAN_URL": "http://example.com/x.pth"},
        {"IMAGEGEN_ESRGAN_SHA256": "abc"},
    ],
)
def test_invalid_settings(env: dict[str, str]) -> None:
    with pytest.raises(ConfigError):
        load_settings({"IMAGEGEN_TOKEN": TOKEN, **env})


def test_offline_follows_hf_hub_offline() -> None:
    assert load_settings({"IMAGEGEN_TOKEN": TOKEN, "HF_HUB_OFFLINE": "1"}).offline
    assert not load_settings({"IMAGEGEN_TOKEN": TOKEN, "HF_HUB_OFFLINE": "0"}).offline


# ---------------------------------------------------------------------------------------------------------- security


def test_token_matching() -> None:
    digest = hashlib.sha256(TOKEN.encode()).digest()
    assert token_matches(f"Bearer {TOKEN}".encode(), digest)
    assert token_matches(f"BEARER   {TOKEN} ".encode(), digest)
    for bad in (None, b"", b"Bearer", f"Bearer {TOKEN[:-1]}".encode(), f"Token {TOKEN}".encode(), TOKEN.encode()):
        assert not token_matches(bad, digest)


# ----------------------------------------------------------------------------------------------------------- weights

PAYLOAD = b"fake esrgan weights" * 1000


def weight_settings(tmp_path: Path, **kw: object):
    return make_settings(
        esrgan_path=tmp_path / "realesrgan" / "RealESRGAN_x4plus.pth",
        esrgan_sha256=hashlib.sha256(PAYLOAD).hexdigest(),
        **kw,
    )


def opener_for(data: bytes, calls: list[str]):
    def opener(url: str, timeout: float):
        calls.append(url)
        return io.BytesIO(data)

    return opener


def test_weights_are_downloaded_verified_and_reused(tmp_path: Path) -> None:
    calls: list[str] = []
    s = weight_settings(tmp_path)
    path = ensure_esrgan_weights(s, opener=opener_for(PAYLOAD, calls))
    assert path.read_bytes() == PAYLOAD
    assert calls == [s.esrgan_url] and s.esrgan_url.startswith("https://github.com/xinntao/Real-ESRGAN/")
    assert ensure_esrgan_weights(s, opener=opener_for(b"", calls)) == path
    assert len(calls) == 1  # cached
    assert [p.name for p in path.parent.iterdir()] == [path.name]  # no temp files left


def test_tampered_or_wrong_downloads_are_rejected(tmp_path: Path) -> None:
    s = weight_settings(tmp_path)
    with pytest.raises(ModelUnavailableError, match="SHA-256"):
        ensure_esrgan_weights(s, opener=opener_for(PAYLOAD + b"x", []))
    assert list(s.esrgan_path.parent.iterdir()) == []
    s.esrgan_path.write_bytes(b"tampered")
    with pytest.raises(ModelUnavailableError, match="mismatch"):
        ensure_esrgan_weights(s, opener=opener_for(PAYLOAD, []))


def test_offline_without_weights_fails_without_network(tmp_path: Path) -> None:
    calls: list[str] = []
    with pytest.raises(ModelUnavailableError, match="offline"):
        ensure_esrgan_weights(weight_settings(tmp_path, offline=True), opener=opener_for(PAYLOAD, calls))
    assert calls == []


def test_network_errors_become_model_unavailable(tmp_path: Path) -> None:
    def failing(url: str, timeout: float):
        raise OSError("connection reset")

    with pytest.raises(ModelUnavailableError, match="download failed"):
        ensure_esrgan_weights(weight_settings(tmp_path), opener=failing)


# ------------------------------------------------------------------------------------------------ CLIs and imports


def test_download_check_reports_missing_models(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("IMAGEGEN_TOKEN", TOKEN)
    seen: list[tuple[str, bool]] = []

    def ok(name: str):
        def step(settings: object, check: bool) -> str:
            seen.append((name, check))
            return f"/models/{name}"

        return step

    def missing(settings, check):
        raise ModelUnavailableError("not there")

    monkeypatch.setattr(download, "STEPS", {"flux": ok("flux"), "birefnet": ok("birefnet"), "esrgan": missing})
    assert download.main(["--check"]) == 1
    assert seen == [("flux", True), ("birefnet", True)]
    assert "MISSING  esrgan" in capsys.readouterr().err
    assert download.main(["--check", "--only", "flux"]) == 0


def test_healthcheck(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMAGEGEN_TOKEN", TOKEN)
    sent: list[dict[str, str]] = []

    class Res(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a: object) -> None:
            return None

    def fake_urlopen(req, timeout):
        sent.append(dict(req.header_items()))
        assert req.full_url == "http://127.0.0.1:8000/healthz"
        return Res(b'{"ok": true, "loaded": []}')

    monkeypatch.setattr(healthcheck.urllib.request, "urlopen", fake_urlopen)
    assert healthcheck.main() == 0
    assert sent[0]["Authorization"] == f"Bearer {TOKEN}"
    monkeypatch.setattr(healthcheck.urllib.request, "urlopen", lambda req, timeout: Res(b'{"ok": false}'))
    assert healthcheck.main() == 1


def test_no_gpu_library_is_imported_by_the_server_modules() -> None:
    code = (
        "import sys, imagegen.app, imagegen.real, imagegen.flux, imagegen.birefnet, imagegen.esrgan, imagegen.gpu, "
        "imagegen.download, imagegen.__main__\n"
        "bad = [m for m in ('torch', 'diffusers', 'transformers', 'spandrel', 'huggingface_hub') if m in sys.modules]\n"
        "assert not bad, bad\n"
    )
    src = Path(__file__).resolve().parents[1] / "src"
    subprocess.run([sys.executable, "-c", code], check=True, env={"PYTHONPATH": str(src)})
