"""Data dictionaries and their sync. Twin of apps/web/src/lib/data-dictionary/content.ts
(`planDictionarySync`, `sanitizeUnitConversions`) and of the front-only apply,
`IDBDataDictionaryStorage.sync` in apps/web/src/lib/storage/idb-storage.ts: the
same key, the same "changed" test, the same unit-row gate."""

import math
import uuid
from datetime import datetime, timezone

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.concept_set import ConceptSet
from app.models.data_dictionary import DataDictionary
from app.schemas.data_dictionary import DataDictionaryCreate, DataDictionarySync, DataDictionaryUpdate

# The fields a sync writes; anything else (the local id, the resolved ids) stays.
_SYNCED_FIELDS = (
    "name", "description", "expression", "source_url", "unique_id", "source_repo",
    "category", "subcategory", "provenance", "version", "translations",
)


def _finite(value: object) -> float | int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value if math.isfinite(value) else None
    if isinstance(value, str) and value.strip():
        try:
            n = float(value)
        except ValueError:
            return None
        if not math.isfinite(n):
            return None
        return int(n) if n.is_integer() else n
    return None


def _sanitize_unit_rows(rows: list | None, numeric: tuple[str, ...], optional: tuple[str, ...], text: tuple[str, ...]) -> list | None:
    """Unit rows' numbers are spliced into the exported extraction SQL: a row
    whose numeric fields are not finite numbers is dropped."""
    if rows is None:
        return None
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        clean: dict = {}
        for key in numeric:
            n = _finite(row.get(key))
            if n is None:
                break
            clean[key] = n
        else:
            bad = False
            for key in optional:
                if row.get(key) is None:
                    continue
                n = _finite(row[key])
                if n is None:
                    bad = True
                    break
                clean[key] = n
            if bad:
                continue
            for key in text:
                if isinstance(row.get(key), str):
                    clean[key] = row[key]
            out.append(clean)
    return out


def sanitize_unit_conversions(rows: list | None) -> list | None:
    return _sanitize_unit_rows(
        rows,
        ("conceptId", "sourceUnitConceptId", "targetUnitConceptId", "conversionFactor"),
        ("offset",),
        ("conceptName", "sourceUnitCode", "sourceUnitName", "targetUnitCode", "targetUnitName"),
    )


def sanitize_recommended_units(rows: list | None) -> list | None:
    return _sanitize_unit_rows(
        rows,
        ("conceptId", "recommendedUnitConceptId"),
        (),
        ("conceptName", "conceptCode", "vocabularyId", "domainId",
         "recommendedUnitName", "recommendedUnitCode", "recommendedUnitVocabularyId"),
    )


def set_key(unique_id: str | None, source_url: str | None) -> str | None:
    """A set's identity across syncs: its authoring tool's uniqueId, else the
    file it came from."""
    return f"u:{unique_id}" if unique_id else (f"f:{source_url}" if source_url else None)


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[DataDictionary]:
    res = await db.execute(select(DataDictionary).where(DataDictionary.workspace_id == workspace_id))
    return list(res.scalars().all())


async def get(db: AsyncSession, dictionary_id: str) -> DataDictionary | None:
    return await db.get(DataDictionary, dictionary_id)


async def create(db: AsyncSession, data: DataDictionaryCreate) -> DataDictionary:
    d = DataDictionary(**data.model_dump(exclude_none=True))
    db.add(d)
    await db.commit()
    await db.refresh(d)
    return d


async def update(db: AsyncSession, d: DataDictionary, data: DataDictionaryUpdate) -> DataDictionary:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(d, key, value)
    await db.commit()
    await db.refresh(d)
    return d


async def delete(db: AsyncSession, d: DataDictionary) -> None:
    # Explicit rather than left to the FK cascade, which SQLite enforces only
    # with foreign_keys on.
    await db.execute(sa_delete(ConceptSet).where(ConceptSet.dictionary_id == d.id))
    await db.delete(d)
    await db.commit()


async def sync(db: AsyncSession, d: DataDictionary, data: DataDictionarySync) -> dict:
    """Make the dictionary's concept sets those of `data`: add the new ones,
    update in place (same id, so projects keep them) the ones that changed,
    drop the ones the repository no longer has. Units are replaced wholesale."""
    res = await db.execute(select(ConceptSet).where(ConceptSet.dictionary_id == d.id))
    # A set with neither key is left alone, as the front plan (the preview the
    # user confirmed) leaves it.
    existing: dict[str, ConceptSet] = {}
    for cs in res.scalars().all():
        key = set_key(cs.unique_id, cs.source_url)
        if key is not None:
            existing[key] = cs
    added = updated = unchanged = 0
    seen: set[str] = set()
    for incoming in data.concept_sets:
        key = set_key(incoming.unique_id, incoming.source_url)
        if key is None or key in seen:
            continue
        seen.add(key)
        values = incoming.model_dump()
        current = existing.get(key)
        if current is None:
            db.add(ConceptSet(id=str(uuid.uuid4()), workspace_id=d.workspace_id, dictionary_id=d.id, **values))
            added += 1
        elif any(getattr(current, f) != values[f] for f in _SYNCED_FIELDS):
            for f in _SYNCED_FIELDS:
                setattr(current, f, values[f])
            # The expression moved: a resolution computed from the old one is stale.
            current.resolved_concept_ids = None
            updated += 1
        else:
            unchanged += 1
    removed = 0
    for key, cs in existing.items():
        if key not in seen:
            await db.delete(cs)
            removed += 1
    d.unit_conversions = sanitize_unit_conversions(data.unit_conversions)
    d.recommended_units = sanitize_recommended_units(data.recommended_units)
    d.commit = data.commit
    d.synced_at = datetime.now(timezone.utc)
    await db.commit()
    return {"added": added, "updated": updated, "removed": removed, "unchanged": unchanged}
