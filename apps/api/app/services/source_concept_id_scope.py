"""Scope a project's assigned source-concept ids to the concepts the project
actually carries, for the per-project export (``source-concept-ids/entries.json``).

The registry (source_concept_id_entries) is WORKSPACE-wide, keyed by
(badgeLabel, vocabularyId, conceptCode). A whole-badge export drags every
project's ids that share the badge (~15 MB for a big badge). This module keeps
only the entries whose (vocab, code) belongs to THIS project — its mappings plus
its source dictionary — so a single-project export stays small while remaining
consistent on reimport (ids are global per (vocab, code) per workspace).

Server-side twin of what the frontend's SourceIdTab derives from DuckDB: the
project's (vocab, code) pair set. This replaces the whole-badge scoping the
client did in buildProjectSourceConceptIds — see docs/planning/server-export-plan.md §6.
"""

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mapping_project import ConceptMapping, MappingProject
from app.models.source_concept_id import SourceConceptIdEntry, SourceConceptIdRange
from app.services import blob_store
from app.services.data import db_connect, file_reader
from app.services.data.file_source import (
    build_source_concepts_select,
    source_concepts_dedup_partition,
)
from app.services.data.global_table_service import _localized


def _badge_labels(project: MappingProject) -> list[str]:
    """The project's badge labels, resolved to canonical 'en' — the key the
    workspace registry uses (mirrors the client, which resolves via localized())."""
    labels = []
    for badge in project.badges or []:
        label = _localized(badge.get("label"), "en")
        if label:
            labels.append(label)
    return labels


async def _mapping_pairs(db: AsyncSession, project_id: str) -> set[tuple[str, str]]:
    """(vocab, code) pairs from the project's mappings."""
    result = await db.execute(
        select(
            ConceptMapping.source_vocabulary_id,
            ConceptMapping.source_concept_code,
        ).where(ConceptMapping.project_id == project_id)
    )
    return {(str(vocab or ""), str(code or "")) for vocab, code in result if code}


def _dictionary_pairs(project: MappingProject) -> set[tuple[str, str]]:
    """(vocab, code) pairs from the project's source dictionary (the CSV blob),
    via the same normalized `source_concepts` view the frontend queries. For a
    file with a real conceptId column the client skips id assignment entirely, so
    there are no scoped entries to keep from the dictionary — mirror that. When no
    terminology column is mapped, the client falls back to the project name as the
    vocab; replicate it so the keys match the registry."""
    fsd = project.file_source_data or {}
    if project.source_type != "file" or not project.raw_file_sha:
        return set()
    if not blob_store.exists(project.raw_file_sha):
        return set()
    column_mapping = fsd.get("columnMapping", {})
    if column_mapping.get("conceptIdColumn"):
        return set()

    select_sql = build_source_concepts_select(column_mapping)
    dedup_partition = source_concepts_dedup_partition(column_mapping)
    path = str(blob_store.path_for(project.raw_file_sha))
    try:
        rows = db_connect.query_file_source(
            path,
            project.raw_file_name,
            fsd.get("parseOptions", {}),
            select_sql,
            dedup_partition,
            "SELECT vocabulary_id, concept_code FROM source_concepts",
            # The scope must cover the WHOLE dictionary — this is the project's
            # (vocab, code) universe, not a preview. The default MAX_QUERY_ROWS
            # cap would truncate a large dictionary to a non-deterministic 10k-row
            # subset, so the exported entries.json would differ on every run and
            # never show as clean. Two narrow columns, so the payload is bounded.
            max_rows=None,
        )
    except file_reader.ExcelSupportUnavailable:
        return set()
    except KeyError:
        # No terminology column → the view omits vocabulary_id. Re-query for the
        # code alone and fall back to the project name as vocab, like the client.
        rows = db_connect.query_file_source(
            path,
            project.raw_file_name,
            fsd.get("parseOptions", {}),
            select_sql,
            dedup_partition,
            "SELECT concept_code FROM source_concepts",
            max_rows=None,
        )
        name = _localized(project.name, "en")
        return {(name, str(r["concept_code"])) for r in rows if r.get("concept_code")}

    pairs: set[tuple[str, str]] = set()
    name = _localized(project.name, "en")
    for r in rows:
        code = r.get("concept_code")
        if not code:
            continue
        vocab = r.get("vocabulary_id") or name
        pairs.add((str(vocab), str(code)))
    return pairs


async def scoped_source_concept_ids(
    db: AsyncSession, project: MappingProject
) -> tuple[list[SourceConceptIdRange], list[SourceConceptIdEntry], list[SourceConceptIdEntry]]:
    """Ranges + project-scoped entries + ALL badge entries for the project's badges.

    The scoped entries are filtered to the (vocab, code) the project actually
    carries (mappings ∪ source dictionary) — that's what entries.json exports. The
    unfiltered badge entries are also returned so range counters can be reconciled
    against every id assigned to the badge (not just this project's slice), which
    the caller needs to keep nextId above the real max. Ranges are returned whole
    (badge-level allocation, not per-concept)."""
    labels = _badge_labels(project)
    if not labels:
        return [], [], []

    ranges_res = await db.execute(
        select(SourceConceptIdRange).where(
            SourceConceptIdRange.workspace_id == project.workspace_id,
            SourceConceptIdRange.badge_label.in_(labels),
        )
    )
    ranges = list(ranges_res.scalars().all())

    entries_res = await db.execute(
        select(SourceConceptIdEntry).where(
            SourceConceptIdEntry.workspace_id == project.workspace_id,
            SourceConceptIdEntry.badge_label.in_(labels),
        )
    )
    all_entries = list(entries_res.scalars().all())

    # The project's (vocab, code) universe. The dictionary read hits DuckDB
    # (blocking), so run it off the event loop.
    pairs = await _mapping_pairs(db, project.id)
    pairs |= await asyncio.to_thread(_dictionary_pairs, project)

    entries = [e for e in all_entries if (e.vocabulary_id, e.concept_code) in pairs]
    return ranges, entries, all_entries
