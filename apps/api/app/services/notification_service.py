from datetime import datetime, timezone

from fastapi import HTTPException, Request, status
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import Notification
from app.models.user import User
from app.schemas.notification import NotificationResponse
from app.services import notification_hub

# Fields that only cache a run's result: a write touching nothing else refreshes
# the open tab but is not worth a notification ("cohort updated" for every Run).
_DERIVED_FIELDS = {"result_count", "attrition", "materialization"}

MAX_KEPT = 200


def client_source(request: Request) -> str | None:
    """The external client behind a request, from X-Linkr-Client ('mcp'), or None
    for the app's own UI."""
    value = request.headers.get("x-linkr-client", "").strip().lower()
    return value[:32] or None


def is_derived_only(changed: set[str]) -> bool:
    return bool(changed) and changed <= _DERIVED_FIELDS


async def record_change(
    db: AsyncSession,
    *,
    user: User,
    source: str | None,
    action: str,
    entity_type: str,
    entity_id: str,
    project_uid: str | None,
    label: dict | str | None,
    detail: dict | None = None,
    undo: dict | None = None,
    notify: bool = True,
) -> None:
    """Tell the user's open tabs an entity changed, and record it in their
    notification centre. No-op for the app's own UI (source None)."""
    if source is None:
        return
    event: dict = {
        "type": "change",
        "action": action,
        "entityType": entity_type,
        "entityId": entity_id,
        "projectUid": project_uid,
    }
    if notify:
        row = Notification(
            # Stamped here, not by the server default: SQLite's CURRENT_TIMESTAMP
            # has whole seconds, and an agent's writes land within one, so the
            # list would come back in arbitrary order.
            created_at=datetime.now(timezone.utc),
            user_id=user.id,
            source=source,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            project_uid=project_uid,
            label=label if isinstance(label, dict) else {"en": label or ""},
            detail=detail,
            undo=undo,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        response = NotificationResponse.model_validate(row)
        response.undoable = undo is not None
        event["notification"] = response.model_dump(mode="json", by_alias=True)
        await _prune(db, user.id)
    notification_hub.publish(user.id, event)


async def _prune(db: AsyncSession, user_id: int) -> None:
    cutoff = (
        await db.execute(
            select(Notification.created_at)
            .where(Notification.user_id == user_id)
            .order_by(Notification.created_at.desc())
            .offset(MAX_KEPT)
            .limit(1)
        )
    ).scalar_one_or_none()
    if cutoff is not None:
        await db.execute(
            delete(Notification).where(Notification.user_id == user_id, Notification.created_at <= cutoff)
        )
        await db.commit()


def _undo_key(n: Notification) -> str | None:
    return f"{n.undo['kind']}:{n.undo['id']}" if n.undo else None


async def list_for_user(db: AsyncSession, user_id: int, limit: int = 50) -> list[NotificationResponse]:
    result = await db.execute(
        select(Notification)
        .where(Notification.user_id == user_id)
        .order_by(Notification.created_at.desc())
        .limit(limit)
    )
    out: list[NotificationResponse] = []
    # Newest first: only the first live change seen for an item may be undone —
    # undoing an older one would overwrite what came after it.
    seen: set[str] = set()
    for n in result.scalars():
        response = NotificationResponse.model_validate(n)
        key = _undo_key(n)
        response.undoable = key is not None and n.undone_at is None and key not in seen
        if key is not None and n.undone_at is None:
            seen.add(key)
        out.append(response)
    return out


async def undo(db: AsyncSession, user: User, notification_id: str) -> None:
    from app.services import undo_service

    row = await db.get(Notification, notification_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    listed = {n.id: n for n in await list_for_user(db, user.id, limit=MAX_KEPT)}
    if not listed.get(row.id) or not listed[row.id].undoable:
        raise HTTPException(status.HTTP_409_CONFLICT, "A later change touched this item; undo that one first")
    gone = await undo_service.apply(db, user, row.project_uid, row.undo)
    row.undone_at = datetime.now(timezone.utc)
    await db.commit()
    # The app's own action, so no new notification — but every open tab re-reads.
    notification_hub.publish(user.id, {
        "type": "change", "action": "deleted" if gone else "updated",
        "entityType": row.entity_type, "entityId": row.entity_id, "projectUid": row.project_uid,
    })


async def mark_all_read(db: AsyncSession, user_id: int) -> None:
    await db.execute(
        update(Notification)
        .where(Notification.user_id == user_id, Notification.read_at.is_(None))
        .values(read_at=datetime.now(timezone.utc))
    )
    await db.commit()


async def clear(db: AsyncSession, user_id: int) -> None:
    await db.execute(delete(Notification).where(Notification.user_id == user_id))
    await db.commit()
