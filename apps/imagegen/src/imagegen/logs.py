"""One JSON object per log line. Callers pass only safe fields: never the token, prompts or image bytes."""

from __future__ import annotations

import json
import logging
import sys
import time

_STANDARD = set(vars(logging.LogRecord("x", 0, "x", 0, "x", None, None))) | {
    "message",
    "asctime",
    "taskName",
    "color_message",  # uvicorn's ANSI-coloured duplicate of msg
}


class _QuietHealthChecks(logging.Filter):
    """Drops access-log lines for successful /healthz probes (Docker runs one every 30 s)."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 5:
            return not (args[2] == "/healthz" and args[4] == 200)
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, object] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in vars(record).items():
            if key not in _STANDARD and not key.startswith("_"):
                out[key] = value if isinstance(value, (str, int, float, bool, type(None), list, dict)) else repr(value)
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=repr)


def setup_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level if level in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL") else "INFO")
    # Library chatter (download progress, warnings about unused weights) stays at warning level.
    for noisy in ("httpx", "httpcore", "urllib3", "filelock", "huggingface_hub", "diffusers", "transformers"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").addFilter(_QuietHealthChecks())
