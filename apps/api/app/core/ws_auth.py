"""WebSocket authentication.

A browser cannot set an Authorization header on a WebSocket handshake, so its
session JWT travels as a `?token=` query param instead. get_current_user
(deps.py) is a FastAPI HTTP dependency and does not apply to a raw WebSocket, so
this replicates its checks: decode, require an access token (or a personal API
token), load an active user.

A personal API token is accepted only in an `Authorization: Bearer` header,
never in the query string: the access log (uvicorn's, and any proxy's) records
the path with its query, and an API token may never expire. A session JWT lasts
hours, which is the exposure the browser path accepts.
"""

import asyncio

from jose import JWTError
from starlette.websockets import WebSocket

from app.core import audit
from app.core.database import async_session
from app.core.security import decode_token, predates_password_change
from app.models.user import User
from app.services import api_token_service

# Application-level close codes (4000-4999 is the private-use range). The client
# shows an error and must NOT reconnect.
WS_AUTH_FAILED = 4401
WS_FORBIDDEN = 4403


async def refuse(websocket: WebSocket, code: int) -> None:
    """Close a socket not yet accepted with `code`. Accepted first: a close during
    the handshake reaches the browser as 1006, the same code as a reverse proxy
    that drops WebSocket upgrades, so the client could only guess why."""
    await websocket.accept()
    await websocket.close(code=code)


def _credentials(websocket: WebSocket) -> tuple[str | None, bool]:
    header = websocket.headers.get("authorization", "")
    scheme, _, bearer = header.partition(" ")
    from_header = scheme.lower() == "bearer" and bool(bearer.strip())
    return (bearer.strip() if from_header else websocket.query_params.get("token")), from_header


async def _resolve(websocket: WebSocket) -> tuple[User | None, str]:
    """The user the socket's credentials stand for, or None; and how they came."""
    token, from_header = _credentials(websocket)
    if not token or (api_token_service.is_api_token(token) and not from_header):
        return None, ""
    if api_token_service.is_api_token(token):
        async with async_session() as db:
            return await api_token_service.authenticate(db, token), "api_key"
    try:
        payload = decode_token(token)
        if payload.get("type") != "access":
            raise JWTError("not an access token")
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        return None, ""
    async with async_session() as db:
        user = await db.get(User, user_id)
    if not user or not user.is_active or predates_password_change(payload, user):
        return None, ""
    return user, "web"


async def authenticate_ws(websocket: WebSocket) -> User | None:
    """Validate the `Authorization: Bearer` header, else the `token` query param.
    Returns the User, or None after having already refused the socket with
    WS_AUTH_FAILED."""
    user, via = await _resolve(websocket)
    if user is None:
        await refuse(websocket, WS_AUTH_FAILED)
        return None
    audit.set_actor(user.id, user.username, via)
    return user


async def watch_credentials(websocket: WebSocket, interval: float) -> None:
    """Return once the credentials the socket opened with stop being valid — the
    session expired, the password changed, the account or API token was revoked.
    A long-lived socket must not outlive the session that opened it."""
    while True:
        await asyncio.sleep(interval)
        try:
            user, _ = await _resolve(websocket)
        except Exception:  # noqa: BLE001 — a failed lookup is not a revoked session: try again next time
            continue
        if user is None:
            return
