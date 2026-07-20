from datetime import datetime
from typing import Any

from pydantic import model_validator

from app.schemas.base import CamelModel

# affiliation/profession are multilingual: a LocalizedString ({"en": ...}) or a
# legacy plain string. name/email/orcid stay single-value facts.
LocalizedOrStr = dict[str, str] | str


class UserCreate(CamelModel):
    username: str
    password: str  # admin-set temporary password; user changes it later
    role: str = "user"
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    affiliation: LocalizedOrStr | None = None
    profession: LocalizedOrStr | None = None
    orcid: str | None = None
    is_active: bool = True


class UserUpdate(CamelModel):
    username: str | None = None  # renaming keeps the same user id → memberships intact
    role: str | None = None
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    affiliation: LocalizedOrStr | None = None
    profession: LocalizedOrStr | None = None
    orcid: str | None = None
    is_active: bool | None = None
    password: str | None = None  # optional reset


class ProfileUpdate(CamelModel):
    """Self-service profile edit (PATCH /auth/me). Only fields a user may change
    on their own account — never role/is_active/username/password."""

    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    affiliation: LocalizedOrStr | None = None
    profession: LocalizedOrStr | None = None
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
    affiliation: LocalizedOrStr | None = None
    profession: LocalizedOrStr | None = None
    orcid: str | None = None


class UserResponse(CamelModel):
    id: int
    username: str
    role: str
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    affiliation: LocalizedOrStr | None = None
    profession: LocalizedOrStr | None = None
    orcid: str | None = None
    is_active: bool
    auth_provider: str
    # Whether the account can authenticate: a local password is set, OR it's an
    # external (SSO/LDAP) account that authenticates elsewhere. The password hash
    # itself is never exposed — only this boolean. Drives whether the UI lets you
    # enable the account (activating a password-less local account is pointless: it
    # still couldn't log in).
    has_password: bool = False
    last_login: datetime | None = None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def _derive_has_password(cls, data: Any) -> Any:
        # `data` is the ORM User (from_attributes). Compute has_password from the
        # hash / auth provider without ever letting the hash into the response.
        if isinstance(data, dict):
            return data
        has_hash = bool(getattr(data, "password_hash", None))
        external = getattr(data, "auth_provider", "local") != "local"
        # Pydantic reads declared fields off the object; inject the computed one via
        # a shim that still resolves everything else from the ORM attributes.
        return _UserSource(data, has_hash or external)


class _UserSource:
    """Attribute proxy over the ORM User that adds a computed `has_password`, so the
    hash never has to appear as a response field."""

    def __init__(self, obj: Any, has_password: bool):
        self._obj = obj
        self.has_password = has_password

    def __getattr__(self, name: str) -> Any:
        return getattr(self._obj, name)
