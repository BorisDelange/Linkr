from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.wiki_page import WikiPage
from app.schemas.wiki_page import WikiPageCreate, WikiPageUpdate


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[WikiPage]:
    result = await db.execute(
        select(WikiPage).where(WikiPage.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, page_id: str) -> WikiPage | None:
    return await db.get(WikiPage, page_id)


async def create(db: AsyncSession, data: WikiPageCreate) -> WikiPage:
    page = WikiPage(**data.model_dump(exclude_none=True))
    db.add(page)
    await db.commit()
    await db.refresh(page)
    return page


async def update(
    db: AsyncSession, page: WikiPage, data: WikiPageUpdate
) -> WikiPage:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(page, key, value)
    await db.commit()
    await db.refresh(page)
    return page


async def delete(db: AsyncSession, page: WikiPage) -> None:
    await db.delete(page)
    await db.commit()


async def delete_for_workspace(db: AsyncSession, workspace_id: str) -> None:
    await db.execute(
        sa_delete(WikiPage).where(WikiPage.workspace_id == workspace_id)
    )
    await db.commit()
