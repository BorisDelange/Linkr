from datetime import datetime
from typing import Literal

from pydantic import field_validator

from app.core.path_ids import SafeId
from app.schemas.base import CamelModel
from app.services.execution.env_options import mask_workspace_credentials


class WorkspaceCreate(CamelModel):
    id: SafeId | None = None  # client supplies crypto.randomUUID()
    name: dict[str, str]
    description: dict[str, str] = {}
    organization_id: str | None = None
    badges: list[dict] | None = None
    badge_categories: list[dict] | None = None
    readme: dict | str | None = None
    # Entity licence ({id, name?, text}); the text travels as LICENSE.md in exports.
    # Present on Update too — a field missing there is silently dropped on
    # git/import round-trips.
    license: dict | None = None
    git_remote_config: dict | None = None
    git_push_policy: Literal["direct", "review"] | None = None
    origin: str = "user"
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    # Creation date preserved on import round-trip; absent → server_default now.
    created_at: datetime | None = None


class WorkspaceUpdate(CamelModel):
    name: dict[str, str] | None = None
    description: dict[str, str] | None = None
    organization_id: str | None = None
    badges: list[dict] | None = None
    badge_categories: list[dict] | None = None
    readme: dict | str | None = None
    license: dict | None = None
    git_remote_config: dict | None = None
    git_push_policy: Literal["direct", "review"] | None = None
    # {"python": [...], "r": [...]} default packages for new projects' environments.
    default_env_packages: dict | None = None
    # {"python": {"indexUrl","trustedHost"}, "r": {"repos","method"}} default install
    # options inherited by new projects' environments.
    default_env_options: dict | None = None
    # Editable authoring provenance (author re-attribution + org snapshot).
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    # Restored on import/clone so the original creation date survives a git
    # round-trip; a normal PATCH never sends it (exclude_unset leaves it alone).
    created_at: datetime | None = None


class WorkspaceResponse(CamelModel):
    id: str
    name: dict[str, str]
    description: dict[str, str]
    organization_id: str | None = None
    badges: list[dict] | None = None
    badge_categories: list[dict] | None = None
    readme: dict | str | None = None
    license: dict | None = None
    git_remote_config: dict | None = None
    git_push_policy: Literal["direct", "review"] | None = None
    default_env_packages: dict | None = None
    default_env_options: dict | None = None
    origin: str
    owner_id: int | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    created_at: datetime
    updated_at: datetime

    @field_validator("default_env_options")
    @classmethod
    def _no_index_credentials(cls, value: dict | None) -> dict | None:
        return mask_workspace_credentials(value)
