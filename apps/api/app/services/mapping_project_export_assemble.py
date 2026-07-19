"""Load a mapping project's data and assemble its export ZIP bytes server-side.

The impure companion to ``mapping_project_export`` (which is pure): this reads the
DB + blob store, scopes the source-concept ids to the project (see
``source_concept_id_scope``), shapes the ORM rows into the camelCase dicts the
pure builder expects — in the SAME key order as the frontend's objects so the
JSON is byte-identical — then zips the resulting file tree.

The zip container mirrors ``git_service.clone_to_zip`` (io.BytesIO + ZIP_DEFLATED,
posix paths). git versions the extracted files, so container byte-reproducibility
across JSZip/zipfile is not required — only the per-file contents, which the
golden tests pin. See docs/planning/server-export-plan.md §3.
"""

import asyncio
import io
import zipfile

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mapping_project import ConceptMapping, MappingProject
from app.services import blob_store
from app.services.mapping_project_export import build_mapping_project_tree
from app.services.source_concept_id_scope import scoped_source_concept_ids

# Order of the project.json keys BEFORE stripping — must match the frontend's
# MappingProject object insertion order so the serialized JSON is byte-identical
# (key order is insertion-order on both sides). Stripping/resetting happens in the
# pure builder; here we only decide which keys exist and in what order.
_PROJECT_KEY_ORDER = (
    "id",
    "entityId",
    "workspaceId",
    "name",
    "description",
    "status",
    "sourceType",
    "dataSourceId",
    "badges",
    "fileSourceData",
)

# ConceptMapping columns → camelCase, in the frontend mapping object's order. Only
# non-null values are emitted (the frontend object omits undefined fields).
_MAPPING_FIELDS = (
    ("source_concept_id", "sourceConceptId"),
    ("source_concept_name", "sourceConceptName"),
    ("source_vocabulary_id", "sourceVocabularyId"),
    ("source_domain_id", "sourceDomainId"),
    ("source_concept_code", "sourceConceptCode"),
    ("target_concept_id", "targetConceptId"),
    ("target_concept_name", "targetConceptName"),
    ("target_vocabulary_id", "targetVocabularyId"),
    ("target_domain_id", "targetDomainId"),
    ("target_concept_code", "targetConceptCode"),
    ("equivalence", "equivalence"),
    ("status", "status"),
    ("mapped_by", "mappedBy"),
    ("mapped_by_details", "mappedByDetails"),
    ("reviewed_by", "reviewedBy"),
    ("reviewed_by_details", "reviewedByDetails"),
    ("comments", "comments"),
    ("reviews", "reviews"),
    # Instance-bookkeeping id/projectId/createdAt/updatedAt are dropped by the
    # pure builder, so they need not be emitted here.
)


def _project_dict(project: MappingProject) -> dict:
    out: dict = {}
    for key in _PROJECT_KEY_ORDER:
        col = _CAMEL_TO_COL.get(key, key)
        value = getattr(project, col, None)
        if value is not None:
            out[key] = value
    return out


_CAMEL_TO_COL = {
    "entityId": "entity_id",
    "workspaceId": "workspace_id",
    "sourceType": "source_type",
    "dataSourceId": "data_source_id",
    "fileSourceData": "file_source_data",
}


def _mapping_dict(m: ConceptMapping) -> dict:
    out: dict = {}
    for col, camel in _MAPPING_FIELDS:
        value = getattr(m, col, None)
        if value is not None:
            out[camel] = value
    return out


def _range_dict(r) -> dict:
    return {
        "badgeLabel": r.badge_label,
        "rangeStart": r.range_start,
        "rangeEnd": r.range_end,
        "nextId": r.next_id,
        "totalConcepts": r.total_concepts,
    }


def _entry_dict(e) -> dict:
    return {
        "badgeLabel": e.badge_label,
        "vocabularyId": e.vocabulary_id,
        "conceptCode": e.concept_code,
        "sourceConceptId": e.source_concept_id,
    }


async def build_mapping_project_tree_from_db(
    db: AsyncSession, project: MappingProject
) -> dict[str, bytes]:
    """Assemble the export file tree for a mapping project from DB + blob store."""
    mappings_res = await db.execute(
        select(ConceptMapping).where(ConceptMapping.project_id == project.id)
    )
    mappings = [_mapping_dict(m) for m in mappings_res.scalars().all()]

    ranges, entries = await scoped_source_concept_ids(db, project)

    # Inline organization: the entity's own frozen snapshot, else the workspace's
    # (resolved by the caller elsewhere). The frozen snapshot on the project is
    # what the export inlines; None → no organization key.
    organization = project.organization or None

    source_csv = None
    if (
        project.source_type == "file"
        and project.raw_file_sha
        and blob_store.exists(project.raw_file_sha)
    ):
        source_csv = await blob_store.read_bytes(project.raw_file_sha)

    return build_mapping_project_tree(
        project=_project_dict(project),
        mappings=mappings,
        ranges=[_range_dict(r) for r in ranges],
        entries=[_entry_dict(e) for e in entries],
        organization=organization,
        source_csv=source_csv,
    )


def _zip_tree(tree: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, content in tree.items():
            zf.writestr(path, content)
    return buf.getvalue()


async def assemble_mapping_project_zip(
    db: AsyncSession, project: MappingProject
) -> bytes:
    """Build the mapping project's export ZIP bytes server-side (no client upload).
    Feeds the same git flow (status/diff/commit-push) that used to receive the
    client-built ZIP."""
    tree = await build_mapping_project_tree_from_db(db, project)
    return await asyncio.to_thread(_zip_tree, tree)
