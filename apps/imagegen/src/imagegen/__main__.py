"""`python -m imagegen`: serve the sidecar with uvicorn (one process: models live in this process's memory)."""

from __future__ import annotations

import logging
import os
import sys

import uvicorn

from .app import create_app
from .config import ConfigError, load_settings
from .logs import setup_logging


def main() -> int:
    setup_logging(os.environ.get("IMAGEGEN_LOG_LEVEL", "INFO").upper())
    log = logging.getLogger("imagegen")
    try:
        settings = load_settings()
    except ConfigError as e:
        log.error("invalid configuration", extra={"reason": str(e)})
        return 2
    app = create_app(settings)
    log.info(
        "starting",
        extra={"port": settings.port, "device": settings.device, "offline": settings.offline, "flux": settings.flux_repo},
    )
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        workers=1,
        log_config=None,
        server_header=False,
        proxy_headers=False,
        forwarded_allow_ips="",
        timeout_keep_alive=5,
        limit_concurrency=32,
        timeout_graceful_shutdown=30,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
