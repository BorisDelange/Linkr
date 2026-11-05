from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.attachment import ReadmeAttachment, WikiAttachment
from app.services import blob_cleanup, blob_store


# --- README attachments (polymorphic owner) --------------------------------


async def list_readme_by_owner(
    db: AsyncSession, owner_type: str, owner_id: str
) -> list[ReadmeAttachment]:
    """Ordered by id — the twin of `writeAttachmentFiles`' sort.

    Without an ORDER BY the row order is arbitrary by SQL contract, so an entity
    with two attachments could export `attachments/_meta.json` in a different
    order here than in the browser: a false git diff flipping on every export."""
    result = await db.execute(
        select(ReadmeAttachment)
        .where(
            ReadmeAttachment.owner_type == owner_type,
            ReadmeAttachment.owner_id == owner_id,
        )
        .order_by(ReadmeAttachment.id)
    )
    return list(result.scalars().all())


async def get_readme(db: AsyncSession, att_id: str) -> ReadmeAttachment | None:
    return await db.get(ReadmeAttachment, att_id)


async def create_readme(
    db: AsyncSession, *, id: str, owner_type: str, owner_id: str,
    workspace_id: str | None = None, file_name: str, mime_type: str,
    created_at: str | None, data: bytes,
) -> ReadmeAttachment:
    sha, size = await blob_store.store_bytes(data)
    att = ReadmeAttachment(
        id=id, owner_type=owner_type, owner_id=owner_id, workspace_id=workspace_id,
        file_name=file_name, mime_type=mime_type, file_size=size, blob_sha=sha,
        created_at=created_at,
    )
    db.add(att)
    await db.commit()
    await db.refresh(att)
    return att


async def delete_readme(db: AsyncSession, att: ReadmeAttachment) -> None:
    sha = att.blob_sha
    await db.delete(att)
    await db.commit()
    await blob_cleanup.deref_blobs(db, {sha})


async def _delete_readme_where(db: AsyncSession, whereclause) -> None:
    result = await db.execute(select(ReadmeAttachment).where(whereclause))
    shas = [a.blob_sha for a in result.scalars().all()]
    await db.execute(sa_delete(ReadmeAttachment).where(whereclause))
    await db.commit()
    for sha in set(shas):
        await blob_cleanup.deref_blobs(db, {sha})


async def delete_readme_for_owner(
    db: AsyncSession, owner_type: str, owner_id: str
) -> None:
    """Called from each owning entity's delete: the polymorphic owner has no FK,
    so nothing cascades on its behalf."""
    await _delete_readme_where(
        db,
        (ReadmeAttachment.owner_type == owner_type)
        & (ReadmeAttachment.owner_id == owner_id),
    )


async def delete_readme_for_workspace(db: AsyncSession, workspace_id: str) -> None:
    await _delete_readme_where(db, ReadmeAttachment.workspace_id == workspace_id)


# --- Wiki attachments (page / workspace-scoped) -----------------------------


def _of_page(page_id: str, workspace_id: str | None):
    return (WikiAttachment.page_id == page_id) & (WikiAttachment.workspace_id == workspace_id)


async def list_wiki_by_page(db: AsyncSession, page_id: str, workspace_id: str | None) -> list[WikiAttachment]:
    """The attachments of a page, in the page's own workspace only."""
    result = await db.execute(select(WikiAttachment).where(_of_page(page_id, workspace_id)))
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
    await blob_cleanup.deref_blobs(db, {sha})


async def _delete_wiki_where(db: AsyncSession, whereclause) -> None:
    result = await db.execute(select(WikiAttachment).where(whereclause))
    shas = [a.blob_sha for a in result.scalars().all()]
    await db.execute(sa_delete(WikiAttachment).where(whereclause))
    await db.commit()
    for sha in set(shas):
        await blob_cleanup.deref_blobs(db, {sha})


async def delete_wiki_for_page(db: AsyncSession, page_id: str, workspace_id: str | None) -> None:
    await _delete_wiki_where(db, _of_page(page_id, workspace_id))


async def delete_wiki_for_workspace(db: AsyncSession, workspace_id: str) -> None:
    await _delete_wiki_where(db, WikiAttachment.workspace_id == workspace_id)
