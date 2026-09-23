import asyncio
import contextlib

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.ws_auth import authenticate_ws
from app.models.user import User
from app.schemas.notification import NotificationResponse
from app.services import notification_hub, notification_service

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationResponse])
async def list_notifications(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await notification_service.list_for_user(db, user.id)


@router.post("/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_read(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await notification_service.mark_all_read(db, user.id)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def clear_notifications(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await notification_service.clear(db, user.id)


@router.websocket("/ws")
async def notifications_ws(websocket: WebSocket):
    """Push entity changes made by external clients to this user's tab. Server →
    client only; anything the client sends is ignored (it only keeps the socket
    alive through proxies)."""
    user = await authenticate_ws(websocket)
    if user is None:
        return
    await websocket.accept()
    queue = notification_hub.subscribe(user.id)

    async def drain_client() -> None:
        while True:
            await websocket.receive_text()

    reader = asyncio.create_task(drain_client())
    try:
        while True:
            getter = asyncio.create_task(queue.get())
            done, _ = await asyncio.wait({getter, reader}, return_when=asyncio.FIRST_COMPLETED)
            if reader in done:
                getter.cancel()
                break
            await websocket.send_json(getter.result())
    except WebSocketDisconnect:
        pass
    finally:
        reader.cancel()
        with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, Exception):
            await reader
        notification_hub.unsubscribe(user.id, queue)
