"""A database's concept profiles (`ConceptProfile`): read by batch, replaced by
batch, summarised for the Concepts tab, dropped with the database's data.

The rows are the browser's — it computes them and owns their shape
(`profile-store.ts`); this keeps them and answers what the views ask.
"""

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from app.models.concept_profile import ConceptProfile
from app.services import stats_cache_service

# Below SQLite's bound-parameter limit, with room for the other conditions.
_CHUNK = 500

#: Where the Concepts tab keeps its profiling run (`stats_cache_service`).
RUN_SCOPE = "concept-profiles"

SECTIONS = (
    "counts", "numeric", "histogram", "categorical", "unit", "frequency",
    "temporal", "hospitalUnits", "missingRate", "perPatient",
)


def _wire(row: ConceptProfile, meta: bool = False) -> dict:
    return {
        "dictKey": row.dict_key,
        "conceptId": row.concept_id,
        "rowsCount": row.rows_count,
        "patientsCount": row.patients_count,
        "json": None if meta else row.profile,
        "sections": [s for s in row.sections.split(",") if s],
        "variant": row.variant,
        "fingerprint": row.fingerprint,
        "computedAt": row.computed_at,
    }


async def read(db: AsyncSession, source_id: str, dict_key: str, concept_ids: list[int], meta: bool = False) -> list[dict]:
    """The stored profiles of these concepts; `meta`: without their JSON — what a
    run plans its queries from (the sections, variant and fingerprint)."""
    out: list[dict] = []
    for i in range(0, len(concept_ids), _CHUNK):
        rows = (await db.execute(
            select(ConceptProfile).options(*([defer(ConceptProfile.profile)] if meta else [])).where(
                ConceptProfile.data_source_id == source_id,
                ConceptProfile.dict_key == dict_key,
                ConceptProfile.concept_id.in_(concept_ids[i:i + _CHUNK]),
            )
        )).scalars().all()
        out.extend(_wire(r, meta) for r in rows)
    return out


async def write(db: AsyncSession, source_id: str, profiles: list[dict]) -> None:
    """Replace the profiles of these concepts, in one transaction: a reader sees
    a concept's old profile or its new one, never neither."""
    by_dict: dict[str, list[int]] = {}
    for p in profiles:
        by_dict.setdefault(p["dictKey"], []).append(int(p["conceptId"]))
    for dict_key, ids in by_dict.items():
        for i in range(0, len(ids), _CHUNK):
            await db.execute(sa_delete(ConceptProfile).where(
                ConceptProfile.data_source_id == source_id,
                ConceptProfile.dict_key == dict_key,
                ConceptProfile.concept_id.in_(ids[i:i + _CHUNK]),
            ))
    # One row per concept: the last of a duplicated one wins, as the delete above expects.
    unique = {(p["dictKey"], int(p["conceptId"])): p for p in profiles}
    db.add_all(
        ConceptProfile(
            data_source_id=source_id,
            dict_key=p["dictKey"],
            concept_id=int(p["conceptId"]),
            rows_count=int(p.get("rowsCount") or 0),
            patients_count=p.get("patientsCount"),
            sections="," + ",".join(s for s in p.get("sections") or [] if s in SECTIONS) + ",",
            variant=p.get("variant") or {},
            fingerprint=str(p.get("fingerprint") or "")[:64],
            computed_at=str(p.get("computedAt") or "")[:40],
            profile=p.get("json") or {},
        )
        for p in unique.values()
    )
    await db.commit()


async def summary(db: AsyncSession, source_id: str) -> dict:
    """How many concepts are profiled, per section and per data fingerprint, the
    last computed, and the Concepts tab's run."""
    scope = ConceptProfile.data_source_id == source_id
    total, last = (await db.execute(
        select(func.count(), func.max(ConceptProfile.computed_at)).where(scope)
    )).one()
    per_section = {}
    for section in SECTIONS:
        per_section[section] = (await db.execute(
            select(func.count()).where(scope, ConceptProfile.sections.like(f"%,{section},%"))
        )).scalar_one()
    fingerprints = dict((await db.execute(
        select(ConceptProfile.fingerprint, func.count()).where(scope).group_by(ConceptProfile.fingerprint)
    )).all())
    run = await stats_cache_service.get(db, RUN_SCOPE, source_id)
    return {
        "count": total,
        "lastComputedAt": last,
        "sections": per_section,
        "fingerprints": fingerprints,
        "run": run.payload if run else None,
    }


async def save_run(db: AsyncSession, source_id: str, computed_at: str, run: dict | None) -> None:
    if run is None:
        await stats_cache_service.delete(db, RUN_SCOPE, source_id)
    else:
        await stats_cache_service.save(db, RUN_SCOPE, source_id, computed_at, run)


async def delete_for_source(db: AsyncSession, source_id: str) -> None:
    await db.execute(sa_delete(ConceptProfile).where(ConceptProfile.data_source_id == source_id))
    await db.commit()
    await stats_cache_service.delete(db, RUN_SCOPE, source_id)
