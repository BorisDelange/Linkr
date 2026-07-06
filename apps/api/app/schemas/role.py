from datetime import datetime

from app.schemas.base import CamelModel


class RoleCreate(CamelModel):
    id: str | None = None  # client supplies crypto.randomUUID()
    name: str
    label: dict[str, str] = {}
    scope: str = "workspace"
    permissions: list[str] = []


class RoleUpdate(CamelModel):
    label: dict[str, str] | None = None
    permissions: list[str] | None = None
    # name/scope of a role are stable once created; not editable here.


class RoleResponse(CamelModel):
    id: str
    name: str
    label: dict[str, str]
    scope: str
    is_system: bool
    permissions: list[str]
    created_at: datetime
    updated_at: datetime
