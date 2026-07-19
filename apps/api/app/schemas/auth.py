from pydantic import BaseModel

# NOTE: these schemas stay snake_case (access_token, refresh_token, needs_setup)
# because the frontend api-client / auth-store read these keys literally.
# This is the one exception to the camelCase API convention (CamelModel).


class LoginRequest(BaseModel):
    username: str
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class UserResponse(BaseModel):
    id: int
    username: str
    email: str | None
    role: str
    is_active: bool

    model_config = {"from_attributes": True}


class MeResponse(BaseModel):
    """Current user + the global-tier permissions their role grants, so the UI can
    gate admin pages/tools (Users, Roles, app-database). Workspace/project
    permissions are fetched per-context, not here."""

    id: int
    username: str
    email: str | None
    role: str
    is_active: bool
    permissions: list[str]
    # Profile fields, so the client can populate /profile without a second call.
    # affiliation/profession are multilingual (LocalizedString) or a legacy string.
    first_name: str | None = None
    last_name: str | None = None
    affiliation: dict[str, str] | str | None = None
    profession: dict[str, str] | str | None = None
    orcid: str | None = None

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserResponse


class SetupStatusResponse(BaseModel):
    needs_setup: bool


class DbInfoResponse(BaseModel):
    """Effective database config the server actually runs on (read-only)."""

    engine: str  # "sqlite" | "postgresql" | other dialect name
    location: str  # file path (SQLite) or host/db (Postgres), password stripped


class SetupRequest(BaseModel):
    username: str
    email: str | None = None
    password: str
