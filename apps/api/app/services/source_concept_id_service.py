from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.source_concept_id import SourceConceptIdEntry, SourceConceptIdRange
from app.schemas.source_concept_id import (
    SourceConceptIdEntrySave,
    SourceConceptIdRangeSave,
)


# --- Ranges (composite key: workspace_id + badge_label) --------------------

async def list_ranges(db: AsyncSession, workspace_id: str) -> list[SourceConceptIdRange]:
    result = await db.execute(
        select(SourceConceptIdRange).where(
            SourceConceptIdRange.workspace_id == workspace_id
        )
    )
    return list(result.scalars().all())


async def get_range(
    db: AsyncSession, workspace_id: str, badge_label: str
) -> SourceConceptIdRange | None:
    return await db.get(SourceConceptIdRange, (workspace_id, badge_label))


async def save_range(
    db: AsyncSession, data: SourceConceptIdRangeSave
) -> SourceConceptIdRange:
    existing = await db.get(
        SourceConceptIdRange, (data.workspace_id, data.badge_label)
    )
    values = data.model_dump()
    if existing is None:
        existing = SourceConceptIdRange(**values)
        db.add(existing)
    else:
        for key, value in values.items():
            setattr(existing, key, value)
    await db.commit()
    await db.refresh(existing)
    return existing


async def delete_range(db: AsyncSession, workspace_id: str, badge_label: str) -> None:
    await db.execute(
        sa_delete(SourceConceptIdRange).where(
            SourceConceptIdRange.workspace_id == workspace_id,
            SourceConceptIdRange.badge_label == badge_label,
        )
    )
    await db.commit()


async def delete_ranges_for_workspace(db: AsyncSession, workspace_id: str) -> None:
    await db.execute(
        sa_delete(SourceConceptIdRange).where(
            SourceConceptIdRange.workspace_id == workspace_id
        )
    )
    await db.commit()


# --- Entries (composite string id) -----------------------------------------

async def list_entries(db: AsyncSession, workspace_id: str) -> list[SourceConceptIdEntry]:
    result = await db.execute(
        select(SourceConceptIdEntry).where(
            SourceConceptIdEntry.workspace_id == workspace_id
        )
    )
    return list(result.scalars().all())


async def list_entries_for_badge(
    db: AsyncSession, workspace_id: str, badge_label: str
) -> list[SourceConceptIdEntry]:
    result = await db.execute(
        select(SourceConceptIdEntry).where(
            SourceConceptIdEntry.workspace_id == workspace_id,
            SourceConceptIdEntry.badge_label == badge_label,
        )
    )
    return list(result.scalars().all())


async def _upsert_entry(db: AsyncSession, data: SourceConceptIdEntrySave) -> None:
    existing = await db.get(SourceConceptIdEntry, data.id)
    values = data.model_dump()
    if existing is None:
        db.add(SourceConceptIdEntry(**values))
    else:
        for key, value in values.items():
            setattr(existing, key, value)


async def save_entry(db: AsyncSession, data: SourceConceptIdEntrySave) -> None:
    await _upsert_entry(db, data)
    await db.commit()


async def save_entries(
    db: AsyncSession, entries: list[SourceConceptIdEntrySave]
) -> None:
    for entry in entries:
        await _upsert_entry(db, entry)
    await db.commit()


async def delete_entries_for_badge(
    db: AsyncSession, workspace_id: str, badge_label: str
) -> None:
    await db.execute(
        sa_delete(SourceConceptIdEntry).where(
            SourceConceptIdEntry.workspace_id == workspace_id,
            SourceConceptIdEntry.badge_label == badge_label,
        )
    )
    await db.commit()


async def delete_entries_for_workspace(db: AsyncSession, workspace_id: str) -> None:
    await db.execute(
        sa_delete(SourceConceptIdEntry).where(
            SourceConceptIdEntry.workspace_id == workspace_id
        )
    )
    await db.commit()
