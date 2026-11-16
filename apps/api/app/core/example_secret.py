"""An instance whose LINKR_SECRET_KEY is a value from a shipped example serves nothing.

That key signs every session, and the examples are public: with it, anyone could sign
in as any user, an administrator included. The process still starts, so the web app
can say why it cannot be used and how to fix it, instead of a bare "server
unreachable": every request is answered 503 `insecure_secret_key`, a websocket is
closed before it opens, and only the health check answers, saying why. A debug run
(local development) is exempt.
"""

from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocket

from app.config import settings

CODE = "insecure_secret_key"
HEALTH_PATH = "/api/v1/health"
MESSAGE = (
    "This server's LINKR_SECRET_KEY is a value published in Linkr's example configuration, so "
    "anyone could sign in as any user, an administrator included. The server refuses every "
    "request until it is replaced: generate a key with "
    "python3 -c 'import secrets; print(secrets.token_urlsafe(48))', set it as LINKR_SECRET_KEY "
    "(in docker/.env for a Docker install) and restart the server. Everyone is signed out once."
)

EXAMPLE_SECRETS = frozenset(
    {"dev-secret-change-in-production", "change-me", "changeme"}
)


def is_example(key: str) -> bool:
    return key.strip().lower() in EXAMPLE_SECRETS


def refusing() -> bool:
    # Read from the settings on every request, not set by the lifespan: an ASGI host
    # that never runs the lifespan must refuse too.
    return is_example(settings.secret_key) and not settings.debug


def refusal() -> dict:
    return {"code": CODE, "message": MESSAGE}


# WebSocket close codes 4000-4999 are left to applications; 4503 mirrors the HTTP status.
WS_CLOSE_CODE = 4503


class ExampleSecretMiddleware:
    """Outside every layer that reads a token, so no signature is checked or made."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] not in ("http", "websocket")
            or not refusing()
            or scope["path"] == HEALTH_PATH
        ):
            await self.app(scope, receive, send)
            return
        response = JSONResponse({"detail": refusal()}, status_code=503)
        if scope["type"] == "http":
            await response(scope, receive, send)
            return
        websocket = WebSocket(scope, receive, send)
        if "websocket.http.response" in scope.get("extensions", {}):
            await websocket.send_denial_response(response)
        else:
            await websocket.close(WS_CLOSE_CODE, CODE)
