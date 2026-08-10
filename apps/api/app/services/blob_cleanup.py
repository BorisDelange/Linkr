"""Reference-counted blob cleanup for project/workspace deletion.

Blobs are content-addressed and deduplicated (see blob_store.py): the same sha
can be referenced by rows in different projects or even different workspaces
(e.g. two data sources importing the same OHDSI vocabulary, or a duplicated
mapping project reusing its source CSV). Deleting a project/workspace cascades
the DB rows, but a referenced blob must not be deleted from disk while another
row still points at it.

Usage: collect the shas a project/workspace's rows reference BEFORE the
cascade delete runs, then call deref_blobs() AFTER commit to drop any blob no
longer referenced by any row anywhere.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.attachment import ReadmeAttachment, WikiAttachment
from app.models.data_source import DataSource, DataSourceFile
from app.models.dataset import DatasetFile
from app.models.mapping_project import MappingProject
from app.models.wiki_page import WikiPage
from app.services import blob_store

# All model/column pairs that can hold a blob sha — used both to collect shas
# before delete and to check "is this sha still referenced?" after delete.
_SHA_COLUMNS = (
    (DatasetFile, DatasetFile.data_sha),
    (DatasetFile, DatasetFile.raw_sha),
    (ReadmeAttachment, ReadmeAttachment.blob_sha),
    (WikiAttachment, WikiAttachment.blob_sha),
    (DataSourceFile, DataSourceFile.content_hash),
    (MappingProject, MappingProject.raw_file_sha),
    (MappingProject, MappingProject.scores_file_sha),
)


async def collect_project_blob_shas(db: AsyncSession, project_uid: str) -> set[str]:
    """Shas referenced by this project's own rows (dataset files, README
    attachments scoped directly to the project). Call before the cascade delete."""
    shas: set[str] = set()

    result = await db.execute(
        select(DatasetFile.data_sha, DatasetFile.raw_sha).where(
            DatasetFile.project_uid == project_uid
        )
    )
    for data_sha, raw_sha in result.all():
        if data_sha:
            shas.add(data_sha)
        if raw_sha:
            shas.add(raw_sha)

    result = await db.execute(
        select(ReadmeAttachment.blob_sha).where(
            ReadmeAttachment.owner_type == "project",
            ReadmeAttachment.owner_id == project_uid,
        )
    )
    shas.update(sha for (sha,) in result.all() if sha)

    return shas


async def collect_workspace_blob_shas(db: AsyncSession, workspace_id: str) -> set[str]:
    """Shas referenced by this workspace's own rows (data source files, mapping
    project source/scores, README/wiki attachments). Does NOT include child
    projects' shas — call collect_project_blob_shas() per project first, before
    this cascade delete runs."""
    shas: set[str] = set()

    result = await db.execute(
        select(DataSourceFile.content_hash)
        .join(DataSource, DataSourceFile.data_source_id == DataSource.id)
        .where(DataSource.workspace_id == workspace_id)
    )
    shas.update(sha for (sha,) in result.all() if sha)

    result = await db.execute(
        select(MappingProject.raw_file_sha, MappingProject.scores_file_sha).where(
            MappingProject.workspace_id == workspace_id
        )
    )
    for raw_sha, scores_sha in result.all():
        if raw_sha:
            shas.add(raw_sha)
        if scores_sha:
            shas.add(scores_sha)

    result = await db.execute(
        select(ReadmeAttachment.blob_sha).where(
            ReadmeAttachment.workspace_id == workspace_id
        )
    )
    shas.update(sha for (sha,) in result.all() if sha)

    result = await db.execute(
        select(WikiAttachment.blob_sha)
        .join(WikiPage, WikiAttachment.page_id == WikiPage.id)
        .where(WikiPage.workspace_id == workspace_id)
    )
    shas.update(sha for (sha,) in result.all() if sha)

    return shas


async def _sha_still_referenced(db: AsyncSession, sha: str) -> bool:
    for model, column in _SHA_COLUMNS:
        result = await db.execute(select(model.id).where(column == sha).limit(1))
        if result.first() is not None:
            return True
    return False


async def deref_blobs(db: AsyncSession, shas: set[str]) -> int:
    """Delete each blob from disk if — AFTER the cascade delete has committed —
    no row anywhere still references its sha. Call this only after the DB
    transaction that removed the referencing rows has committed, so the check
    reflects the post-delete state. Returns the count actually deleted."""
    deleted = 0
    for sha in shas:
        if not sha:
            continue
        if await _sha_still_referenced(db, sha):
            continue
        await blob_store.delete(sha)
        deleted += 1
    return deleted
