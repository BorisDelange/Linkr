"""WebSocket authentication.

A browser cannot set an Authorization header on a WebSocket handshake, so the
JWT travels as a `?token=` query param instead. get_current_user (deps.py) is a
FastAPI HTTP dependency and does not apply to a raw WebSocket, so this replicates
its checks: decode, require an access token, load an active user.
"""

from jose import JWTError
from starlette.websockets import WebSocket

from app.core.database import async_session
from app.core.security import decode_token
from app.models.user import User

# Application-level close code for an authentication failure (4000-4999 is the
# private-use range). The client shows an error and must NOT reconnect.
WS_AUTH_FAILED = 4401


async def authenticate_ws(websocket: WebSocket) -> User | None:
    """Validate the `token` query param. Returns the User, or None after having
    already closed the socket with WS_AUTH_FAILED."""
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=WS_AUTH_FAILED)
        return None
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
    if not user or not user.is_active:
        await websocket.close(code=WS_AUTH_FAILED)
        return None
    return user
