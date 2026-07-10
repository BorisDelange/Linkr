from datetime import datetime

from app.schemas.base import CamelModel


class WikiPageCreate(CamelModel):
    id: str  # client supplies crypto.randomUUID()
    workspace_id: str
    entity_id: str | None = None
    parent_id: str | None = None
    title: dict[str, str] = {}
    slug: str = ""
    icon: str | None = None
    content: dict[str, str] = {}
    template: str | None = None
    owner: str | None = None
    verified: bool | None = None
    verified_at: str | None = None
    review_due_at: str | None = None
    sort_order: int = 0
    created_by: str | None = None
    created_by_details: dict | None = None


class WikiPageUpdate(CamelModel):
    workspace_id: str | None = None
    entity_id: str | None = None
    parent_id: str | None = None
    title: dict[str, str] | None = None
    slug: str | None = None
    icon: str | None = None
    content: dict[str, str] | None = None
    template: str | None = None
    owner: str | None = None
    verified: bool | None = None
    verified_at: str | None = None
    review_due_at: str | None = None
    sort_order: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None


class WikiPageResponse(CamelModel):
    id: str
    workspace_id: str | None = None
    entity_id: str | None = None
    parent_id: str | None = None
    title: dict[str, str]
    slug: str
    icon: str | None = None
    content: dict[str, str]
    template: str | None = None
    owner: str | None = None
    verified: bool | None = None
    verified_at: str | None = None
    review_due_at: str | None = None
    sort_order: int
    created_by: str | None = None
    created_by_details: dict | None = None
    created_at: datetime
    updated_at: datetime
