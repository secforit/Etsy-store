# syntax=docker/dockerfile:1.7
#
# imagegen GPU sidecar: FLUX.2 [klein] 4B + BiRefNet + Real-ESRGAN x4plus (docs/MODELS.md).
# Built by deploy/docker-compose.yml (service `imagegen`): no published port, internal network only, GPU reserved,
# Hugging Face cache on the `hf-models` volume at /models.
#
# CUDA: torch 2.14.1 is the CUDA 13.0 build (kernels for sm_75/80/86/90; the RTX 3060 is sm_86). The base image is the
# matching CUDA 13.0 runtime; the host driver 595 (CUDA 13.2) is newer, which CUDA supports.

ARG CUDA_IMAGE=nvidia/cuda:13.0.3-runtime-ubuntu24.04@sha256:76f46f3e649824ebd3685d3d86c42b0ea62af04f59242f419f56cd5804a72efb
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21

FROM ${UV_IMAGE} AS uv

FROM ${CUDA_IMAGE} AS base
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3.12 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---- dependencies: exact versions + hashes from requirements.lock (wheels only, nothing compiled) ----
FROM base AS deps
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never
WORKDIR /build
COPY requirements.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv --python /usr/bin/python3.12 /opt/venv \
 && uv pip sync --python /opt/venv/bin/python --require-hashes --only-binary :all: requirements.lock

# ---- runtime ----
FROM base AS runtime
# uid 1000 like the other services (the Ubuntu base ships a `ubuntu` user with that uid: replace it).
RUN (userdel --remove ubuntu 2>/dev/null || true) \
 && groupadd --gid 1000 app \
 && useradd --uid 1000 --gid 1000 --home-dir /home/app --create-home --shell /usr/sbin/nologin app \
 && mkdir -p /models \
 && chown app:app /models
COPY --from=deps /opt/venv /opt/venv
COPY src/ /app/src/
ENV PATH=/opt/venv/bin:${PATH} \
    PYTHONPATH=/app/src \
    HF_HOME=/models \
    IMAGEGEN_MODELS_DIR=/models \
    TORCH_HOME=/models/torch \
    XDG_CACHE_HOME=/tmp/cache \
    TRITON_CACHE_DIR=/tmp/triton \
    HF_HUB_DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1 \
    TRANSFORMERS_NO_ADVISORY_WARNINGS=1 \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
WORKDIR /app
USER app
# Writes go only to /models (weights) and /tmp (caches), so the container also works with `read_only: true` + a /tmp
# tmpfs. Named volume for weights (~15.5 GB): FLUX.2 klein 4B, BiRefNet, Real-ESRGAN. New volumes inherit app:app.
VOLUME ["/models"]
# /healthz needs the bearer token too; the probe reads IMAGEGEN_TOKEN(_FILE) like the server and never prints it.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["python", "-m", "imagegen.healthcheck"]
# Listens on 0.0.0.0:8000 inside the container only; compose publishes no port (reach it as http://imagegen:8000).
CMD ["python", "-m", "imagegen"]
