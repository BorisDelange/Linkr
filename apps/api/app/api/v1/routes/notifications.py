import asyncio
import contextlib
import json
from datetime import datetime, timezone

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


@router.get("/ui-context")
async def ui_context(user: User = Depends(get_current_user)) -> dict | None:
    """Where the user is in the Linkr tab they last focused — project, page, open
    cohort / dashboard / dataset — or null when no tab is open. Lets an agent
    resolve "this cohort" or "here"."""
    return notification_hub.get_context(user.id)


@router.post("/{notification_id}/undo", status_code=status.HTTP_204_NO_CONTENT)
async def undo_notification(
    notification_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reverse the change this notification reports."""
    await notification_service.undo(db, user, notification_id)


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
    """Push entity changes made by external clients to this user's tab. The only
    thing a client sends is where the user is (`ui-context`); anything else is
    ignored."""
    user = await authenticate_ws(websocket)
    if user is None:
        return
    await websocket.accept()
    queue = notification_hub.subscribe(user.id)

    async def drain_client() -> None:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(message, dict) or message.get("type") != "ui-context":
                continue
            context = message.get("context")
            if isinstance(context, dict) and len(raw) < 4096:
                notification_hub.set_context(
                    user.id, {**context, "reportedAt": datetime.now(timezone.utc).isoformat()}
                )

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
