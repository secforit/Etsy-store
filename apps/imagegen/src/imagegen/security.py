"""ASGI guard in front of every route: bearer token first, then body-size limits, then the app.

It runs before FastAPI reads any request body, so an unauthenticated or oversized request never gets parsed.
The token is compared in constant time (hmac.compare_digest over SHA-256 digests, so its length does not leak either).
"""

from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Mapping
from typing import Any

from starlette.types import ASGIApp, Message, Receive, Scope, Send


class BodyTooLargeError(Exception):
    """Raised from receive() once a request body passes its route's limit."""


SECURITY_HEADERS: tuple[tuple[bytes, bytes], ...] = (
    (b"cache-control", b"no-store"),
    (b"x-content-type-options", b"nosniff"),
)


def token_matches(header_value: bytes | None, expected_digest: bytes) -> bool:
    if not header_value:
        return False
    scheme, _, credentials = header_value.strip().partition(b" ")
    if scheme.lower() != b"bearer":
        return False
    credentials = credentials.strip()
    if not credentials:
        return False
    return hmac.compare_digest(hashlib.sha256(credentials).digest(), expected_digest)


async def send_json(send: Send, status: int, payload: dict[str, Any], headers: tuple[tuple[bytes, bytes], ...] = ()) -> None:
    body = json.dumps(payload).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                *SECURITY_HEADERS,
                *headers,
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class GuardMiddleware:
    def __init__(self, app: ASGIApp, *, token: str, body_limits: Mapping[str, int], default_limit: int) -> None:
        self.app = app
        self._digest = hashlib.sha256(token.encode("utf-8")).digest()
        self._limits = dict(body_limits)
        self._default_limit = default_limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":  # lifespan
            await self.app(scope, receive, send)
            return

        auth: bytes | None = None
        content_length: bytes | None = None
        for name, value in scope.get("headers", ()):
            if name == b"authorization" and auth is None:
                auth = value
            elif name == b"content-length" and content_length is None:
                content_length = value

        if not token_matches(auth, self._digest):
            await send_json(send, 401, {"error": "unauthorized"}, ((b"www-authenticate", b"Bearer"),))
            return

        limit = self._limits.get(scope.get("path", ""), self._default_limit)
        if content_length is not None:
            if not content_length.isdigit():
                await send_json(send, 400, {"error": "invalid_content_length"})
                return
            if int(content_length) > limit:
                await send_json(send, 413, {"error": "body_too_large", "limit_bytes": limit})
                return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise BodyTooLargeError()
            return message

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                existing = {k.lower() for k, _ in message.get("headers", [])}
                extra = [(k, v) for k, v in SECURITY_HEADERS if k not in existing]
                message = {**message, "headers": [*message.get("headers", []), *extra]}
            await send(message)

        await self.app(scope, limited_receive, send_with_headers)
