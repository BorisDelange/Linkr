import re

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.wiki_page import WikiPage
from app.schemas.wiki_page import (
    WikiPageCreate,
    WikiPageSearchResult,
    WikiPageUpdate,
)

_SNIPPET_RADIUS = 80


def _localized_values(value: object) -> list[str]:
    """All text values of a possibly-localized field. Mirrors the frontend
    toLocalized: a plain string counts as its own single value; a
    {en, fr, ...} object contributes each language string."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [v for v in value.values() if isinstance(v, str)]
    return []


def _strip_markdown(text: str) -> str:
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[#>*_`~\-]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _make_snippet(content_values: list[str], q: str) -> str:
    for raw in content_values:
        plain = _strip_markdown(raw)
        idx = plain.lower().find(q)
        if idx < 0:
            continue
        start = max(0, idx - _SNIPPET_RADIUS)
        end = min(len(plain), idx + len(q) + _SNIPPET_RADIUS)
        snippet = plain[start:end].strip()
        prefix = "..." if start > 0 else ""
        suffix = "..." if end < len(plain) else ""
        return f"{prefix}{snippet}{suffix}"
    first = next((_strip_markdown(v) for v in content_values if v.strip()), "")
    return first[: _SNIPPET_RADIUS * 2].strip()


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[WikiPage]:
    result = await db.execute(
        select(WikiPage).where(WikiPage.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def search_for_workspace(
    db: AsyncSession, workspace_id: str, query: str
) -> list[WikiPageSearchResult]:
    q = query.strip().lower()
    if not q:
        return []
    pages = await list_for_workspace(db, workspace_id)
    results: list[WikiPageSearchResult] = []
    for page in pages:
        title_values = _localized_values(page.title)
        content_values = _localized_values(page.content)
        haystack = " ".join(title_values + content_values).lower()
        if q not in haystack:
            continue
        if isinstance(page.title, dict):
            title = page.title
        elif isinstance(page.title, str):
            title = {"en": page.title, "fr": page.title}
        else:
            title = {}
        results.append(
            WikiPageSearchResult(
                id=page.id,
                title=title,
                snippet=_make_snippet(content_values, q),
            )
        )
    return results


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
