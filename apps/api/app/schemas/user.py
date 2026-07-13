from datetime import datetime

from app.schemas.base import CamelModel


class UserCreate(CamelModel):
    username: str
    password: str  # admin-set temporary password; user changes it later
    role: str = "user"
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    affiliation: str | None = None
    profession: str | None = None
    orcid: str | None = None
    is_active: bool = True


class UserUpdate(CamelModel):
    username: str | None = None  # renaming keeps the same user id → memberships intact
    role: str | None = None
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    affiliation: str | None = None
    profession: str | None = None
    orcid: str | None = None
    is_active: bool | None = None
    password: str | None = None  # optional reset


class ProfileUpdate(CamelModel):
    """Self-service profile edit (PATCH /auth/me). Only fields a user may change
    on their own account — never role/is_active/username/password."""

    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    affiliation: str | None = None
    profession: str | None = None
    orcid: str | None = None


class UserDirectoryEntry(CamelModel):
    """Minimal user info for member pickers + author-name resolution, plus the
    public professional identity fields (affiliation / profession / ORCID) needed
    to build an author provenance snapshot when re-attributing authorship. Still
    exposes no email, role, or secrets."""

    id: int
    username: str
    first_name: str | None = None
    last_name: str | None = None
    affiliation: str | None = None
    profession: str | None = None
    orcid: str | None = None


class UserResponse(CamelModel):
    id: int
    username: str
    role: str
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    affiliation: str | None = None
    profession: str | None = None
    orcid: str | None = None
    is_active: bool
    auth_provider: str
    last_login: datetime | None = None
    created_at: datetime
    updated_at: datetime
