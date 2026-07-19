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
from app.schemas.mapping_project import ConceptMappingResponse, MappingProjectResponse
from app.services import blob_store
from app.services.mapping_project_export import build_mapping_project_tree
from app.services.source_concept_id_scope import scoped_source_concept_ids


def _project_dict(project: MappingProject) -> dict:
    """The project as the CLIENT sees it in server mode — i.e. exactly what the
    API emits: MappingProjectResponse dumped by camelCase alias, in schema order,
    with EVERY field present (None → null, no exclude_none). Feeding this to the
    pure builder (which strips + resets) reproduces the frontend's project.json
    byte for byte. Building the dict by hand drifted from the real field set/order."""
    return MappingProjectResponse.model_validate(project).model_dump(
        by_alias=True, mode="json"
    )


def _mapping_dict(m: ConceptMapping) -> dict:
    """The mapping as the client sees it: ConceptMappingResponse, camelCase alias,
    all fields present (None → null). The pure builder drops id/projectId/created/
    updated and keeps the rest in this exact order."""
    return ConceptMappingResponse.model_validate(m).model_dump(
        by_alias=True, mode="json"
    )


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
