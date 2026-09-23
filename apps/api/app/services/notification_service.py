from datetime import datetime, timezone

from fastapi import Request
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
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        event["notification"] = NotificationResponse.model_validate(row).model_dump(mode="json", by_alias=True)
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


async def list_for_user(db: AsyncSession, user_id: int, limit: int = 50) -> list[Notification]:
    result = await db.execute(
        select(Notification)
        .where(Notification.user_id == user_id)
        .order_by(Notification.created_at.desc())
        .limit(limit)
    )
    return list(result.scalars())


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
