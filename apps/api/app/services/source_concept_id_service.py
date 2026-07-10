from sqlalchemy import and_, delete as sa_delete
from sqlalchemy import func, select
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


async def count_entries_by_badge(
    db: AsyncSession, workspace_id: str
) -> list[dict]:
    """Per-badge entry counts for the workspace WITHOUT transferring the rows:
    total assigned, and how many fall inside the badge's own range. Loading every
    entry just to `.length` them was the source of the slow Source IDs tab reload
    (100k+ rows as JSON each time)."""
    total_col = func.count().label("assigned_count")
    result = await db.execute(
        select(SourceConceptIdEntry.badge_label, total_col)
        .where(SourceConceptIdEntry.workspace_id == workspace_id)
        .group_by(SourceConceptIdEntry.badge_label)
    )
    totals = {row[0]: row[1] for row in result.all()}

    # own_count: entries whose id sits within the badge's own [range_start, range_end].
    own_result = await db.execute(
        select(
            SourceConceptIdEntry.badge_label,
            func.count().label("own_count"),
        )
        .join(
            SourceConceptIdRange,
            and_(
                SourceConceptIdRange.workspace_id == SourceConceptIdEntry.workspace_id,
                SourceConceptIdRange.badge_label == SourceConceptIdEntry.badge_label,
            ),
        )
        .where(
            SourceConceptIdEntry.workspace_id == workspace_id,
            SourceConceptIdEntry.source_concept_id >= SourceConceptIdRange.range_start,
            SourceConceptIdEntry.source_concept_id <= SourceConceptIdRange.range_end,
        )
        .group_by(SourceConceptIdEntry.badge_label)
    )
    owns = {row[0]: row[1] for row in own_result.all()}

    return [
        {"badgeLabel": label, "assignedCount": count, "ownCount": owns.get(label, 0)}
        for label, count in totals.items()
    ]


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
