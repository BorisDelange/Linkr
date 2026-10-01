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

from jose import JWTError
from starlette.websockets import WebSocket

from app.core import audit
from app.core.database import async_session
from app.core.security import decode_token, predates_password_change
from app.models.user import User
from app.services import api_token_service

# Application-level close code for an authentication failure (4000-4999 is the
# private-use range). The client shows an error and must NOT reconnect.
WS_AUTH_FAILED = 4401


async def authenticate_ws(websocket: WebSocket) -> User | None:
    """Validate the `Authorization: Bearer` header, else the `token` query param.
    Returns the User, or None after having already closed the socket with
    WS_AUTH_FAILED."""
    header = websocket.headers.get("authorization", "")
    scheme, _, bearer = header.partition(" ")
    from_header = scheme.lower() == "bearer" and bool(bearer.strip())
    token = bearer.strip() if from_header else websocket.query_params.get("token")
    if not token or (api_token_service.is_api_token(token) and not from_header):
        await websocket.close(code=WS_AUTH_FAILED)
        return None
    if api_token_service.is_api_token(token):
        async with async_session() as db:
            user = await api_token_service.authenticate(db, token)
        if user is None:
            await websocket.close(code=WS_AUTH_FAILED)
        else:
            audit.set_actor(user.id, user.username, "api_key")
        return user
    try:
        payload = decode_token(token)
        if payload.get("type") != "access":
            raise JWTError("not an access token")
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        await websocket.close(code=WS_AUTH_FAILED)
        return None

    async with async_session() as db:
        user = await db.get(User, user_id)
    if not user or not user.is_active or predates_password_change(payload, user):
        await websocket.close(code=WS_AUTH_FAILED)
        return None
    audit.set_actor(user.id, user.username, "web")
    return user
