"""Docker HEALTHCHECK: `python -m imagegen.healthcheck` -> exit 0 when GET /healthz answers {"ok": true}.

Reads the token exactly like the server (IMAGEGEN_TOKEN or IMAGEGEN_TOKEN_FILE) and never prints it.
"""

from __future__ import annotations

import json
import sys
import urllib.request

from .config import ConfigError, load_settings


def main() -> int:
    try:
        settings = load_settings()
    except ConfigError as e:
        print(f"unhealthy: {e}", file=sys.stderr)
        return 1
    req = urllib.request.Request(
        f"http://127.0.0.1:{settings.port}/healthz",
        headers={"Authorization": f"Bearer {settings.token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            body = json.loads(res.read(64 * 1024))
    except Exception as e:
        print(f"unhealthy: {type(e).__name__}", file=sys.stderr)
        return 1
    return 0 if isinstance(body, dict) and body.get("ok") is True else 1


if __name__ == "__main__":
    sys.exit(main())
