from sqlalchemy import delete as sa_delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.attachment import ReadmeAttachment, WikiAttachment
from app.services import blob_store


async def _blob_unreferenced(db: AsyncSession, model, sha: str) -> bool:
    """True if no row of either attachment table still points at this sha —
    blobs are shared/deduped, so only delete the bytes once nothing references
    them (mirrors dataset_service's reference check)."""
    for m in (ReadmeAttachment, WikiAttachment):
        count = await db.scalar(
            select(func.count()).select_from(m).where(m.blob_sha == sha)
        )
        if count:
            return False
    return True


# --- README attachments (project-scoped) -----------------------------------


async def list_readme(db: AsyncSession, project_uid: str) -> list[ReadmeAttachment]:
    result = await db.execute(
        select(ReadmeAttachment).where(ReadmeAttachment.project_uid == project_uid)
    )
    return list(result.scalars().all())


async def list_readme_by_workspace(db: AsyncSession, workspace_id: str) -> list[ReadmeAttachment]:
    result = await db.execute(
        select(ReadmeAttachment).where(ReadmeAttachment.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get_readme(db: AsyncSession, att_id: str) -> ReadmeAttachment | None:
    return await db.get(ReadmeAttachment, att_id)


async def create_readme(
    db: AsyncSession, *, id: str, project_uid: str | None = None,
    workspace_id: str | None = None, file_name: str, mime_type: str,
    created_at: str | None, data: bytes,
) -> ReadmeAttachment:
    sha, size = await blob_store.store_bytes(data)
    att = ReadmeAttachment(
        id=id, project_uid=project_uid, workspace_id=workspace_id, file_name=file_name,
        mime_type=mime_type, file_size=size, blob_sha=sha, created_at=created_at,
    )
    db.add(att)
    await db.commit()
    await db.refresh(att)
    return att


async def delete_readme(db: AsyncSession, att: ReadmeAttachment) -> None:
    sha = att.blob_sha
    await db.delete(att)
    await db.commit()
    if await _blob_unreferenced(db, ReadmeAttachment, sha):
        await blob_store.delete(sha)


async def _delete_readme_where(db: AsyncSession, whereclause) -> None:
    result = await db.execute(select(ReadmeAttachment).where(whereclause))
    shas = [a.blob_sha for a in result.scalars().all()]
    await db.execute(sa_delete(ReadmeAttachment).where(whereclause))
    await db.commit()
    for sha in set(shas):
        if await _blob_unreferenced(db, ReadmeAttachment, sha):
            await blob_store.delete(sha)


async def delete_readme_for_project(db: AsyncSession, project_uid: str) -> None:
    await _delete_readme_where(db, ReadmeAttachment.project_uid == project_uid)


async def delete_readme_for_workspace(db: AsyncSession, workspace_id: str) -> None:
    await _delete_readme_where(db, ReadmeAttachment.workspace_id == workspace_id)


# --- Wiki attachments (page / workspace-scoped) -----------------------------


async def list_wiki_by_page(db: AsyncSession, page_id: str) -> list[WikiAttachment]:
    result = await db.execute(
        select(WikiAttachment).where(WikiAttachment.page_id == page_id)
    )
    return list(result.scalars().all())


async def list_wiki_by_workspace(db: AsyncSession, workspace_id: str) -> list[WikiAttachment]:
    result = await db.execute(
        select(WikiAttachment).where(WikiAttachment.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get_wiki(db: AsyncSession, att_id: str) -> WikiAttachment | None:
    return await db.get(WikiAttachment, att_id)


async def create_wiki(
    db: AsyncSession, *, id: str, page_id: str, workspace_id: str, file_name: str,
    mime_type: str, created_at: str | None, data: bytes,
) -> WikiAttachment:
    sha, size = await blob_store.store_bytes(data)
    att = WikiAttachment(
        id=id, page_id=page_id, workspace_id=workspace_id, file_name=file_name,
        mime_type=mime_type, file_size=size, blob_sha=sha, created_at=created_at,
    )
    db.add(att)
    await db.commit()
    await db.refresh(att)
    return att


async def delete_wiki(db: AsyncSession, att: WikiAttachment) -> None:
    sha = att.blob_sha
    await db.delete(att)
    await db.commit()
    if await _blob_unreferenced(db, WikiAttachment, sha):
        await blob_store.delete(sha)


async def _delete_wiki_where(db: AsyncSession, whereclause) -> None:
    result = await db.execute(select(WikiAttachment).where(whereclause))
    shas = [a.blob_sha for a in result.scalars().all()]
    await db.execute(sa_delete(WikiAttachment).where(whereclause))
    await db.commit()
    for sha in set(shas):
        if await _blob_unreferenced(db, WikiAttachment, sha):
            await blob_store.delete(sha)


async def delete_wiki_for_page(db: AsyncSession, page_id: str) -> None:
    await _delete_wiki_where(db, WikiAttachment.page_id == page_id)


async def delete_wiki_for_workspace(db: AsyncSession, workspace_id: str) -> None:
    await _delete_wiki_where(db, WikiAttachment.workspace_id == workspace_id)
