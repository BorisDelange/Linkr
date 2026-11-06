"""Refuse an oversized body before anything buffers it.

FastAPI reads and parses a route's whole body before solving its dependencies, so
the check cannot wait for authentication: it runs on the raw request. Routes with a
form or no body model stream or spool theirs and enforce their own limits.
"""

import re

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from starlette.routing import compile_path
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import settings

_MB = 1024 * 1024
_SIGN_IN_PREFIXES = ("/api/v1/auth/", "/api/v1/setup/")
_SIGN_IN_LIMIT = _MB
_BODY_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


_FORM_TYPES = ("multipart/form-data", "application/x-www-form-urlencoded")
_whole_body_routes: list[tuple[str, re.Pattern[str]]] | None = None


def _routes_reading_whole_body(app: FastAPI) -> list[tuple[str, re.Pattern[str]]]:
    """Read from the OpenAPI schema, the public description of each route's body."""
    global _whole_body_routes
    if _whole_body_routes is None:
        _whole_body_routes = [
            (method.upper(), compile_path(path)[0])
            for path, operations in app.openapi()["paths"].items()
            for method, operation in operations.items()
            if (content := operation.get("requestBody", {}).get("content"))
            and not any(kind in content for kind in _FORM_TYPES)
        ]
    return _whole_body_routes


def _limit_for(app: FastAPI, method: str, path: str) -> int | None:
    if path.startswith(_SIGN_IN_PREFIXES):
        return _SIGN_IN_LIMIT
    reads_whole_body = any(m == method and regex.match(path) for m, regex in _routes_reading_whole_body(app))
    return settings.max_json_body_mb * _MB if reads_whole_body else None


def _declared_length(scope: Scope) -> int | None:
    for name, value in scope["headers"]:
        if name == b"content-length":
            return int(value) if value.isdigit() else None
    return None


class BodySizeLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in _BODY_METHODS:
            await self.app(scope, receive, send)
            return
        declared = _declared_length(scope)
        limit = None if declared is not None and declared <= _SIGN_IN_LIMIT else _limit_for(scope["app"], scope["method"], scope["path"])
        if limit is None:
            await self.app(scope, receive, send)
            return
        if declared is not None and declared > limit:
            await _too_large(scope, receive, send)
            return

        seen = 0

        async def counted() -> Message:
            nonlocal seen
            message = await receive()
            seen += len(message.get("body", b""))
            if seen > limit:
                raise HTTPException(413, "Request body too large")
            return message

        await self.app(scope, counted, send)


async def _too_large(scope: Scope, receive: Receive, send: Send) -> None:
    await JSONResponse({"detail": "Request body too large"}, status_code=413)(scope, receive, send)
