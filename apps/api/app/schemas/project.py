from datetime import datetime

from app.schemas.base import CamelModel


class ProjectCreate(CamelModel):
    uid: str | None = None  # client supplies crypto.randomUUID()
    entity_id: str | None = None
    project_id: str | None = None
    workspace_id: str | None = None
    name: dict[str, str]
    description: dict[str, str] = {}
    short_description: dict[str, str] = {}
    config: dict = {}
    git_remote_config: dict | None = None
    status: str | None = None
    badges: list[dict] | None = None
    todos: list[dict] | None = None
    # LocalizedString; accept a bare string too for legacy data / round-trips.
    notes: dict | str | None = None
    readme: dict | str | None = None
    # Entity licence ({id, name?, text}); the text travels as LICENSE.md in exports.
    # Present on Update too — a field missing there is silently dropped on
    # git/import round-trips.
    license: dict | None = None
    linked_data_source_ids: list[str] | None = None
    # Portable identities of the databases above, one per entry: the ids are
    # stripped from every export, so these are what travel.
    linked_data_source_refs: list | None = None
    organization: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    catalog_visibility: str | None = None
    origin: str = "user"
    # Preserved on import (round-trip); for fresh creates the server stamps the
    # current user, so these are optional here.
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    # Creation date preserved on import round-trip. Absent for a fresh create or a
    # legacy file → excluded by exclude_none → server_default stamps now.
    created_at: datetime | None = None
    version: str = "0.1.0"


class ProjectUpdate(CamelModel):
    entity_id: str | None = None
    project_id: str | None = None
    workspace_id: str | None = None
    name: dict[str, str] | None = None
    description: dict[str, str] | None = None
    short_description: dict[str, str] | None = None
    config: dict | None = None
    git_remote_config: dict | None = None
    status: str | None = None
    badges: list[dict] | None = None
    todos: list[dict] | None = None
    notes: dict | str | None = None
    readme: dict | str | None = None
    license: dict | None = None
    linked_data_source_ids: list[str] | None = None
    # Portable identities of the databases above, one per entry: the ids are
    # stripped from every export, so these are what travel.
    linked_data_source_refs: list | None = None
    organization: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    catalog_visibility: str | None = None
    # Absolute server paths the IDE working dir / code / datasets dirs resolve to
    # (server mode). Machine-local: stripped from exports (see _INSTANCE_FIELDS).
    ide_path: str | None = None
    scripts_path: str | None = None
    datasets_path: str | None = None
    # Editable authoring provenance (author re-attribution + org snapshot).
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    version: str | None = None
    # Restored on import/clone so the original creation date survives a git
    # round-trip (a git-pointer create stamps func.now(); the follow-up clone
    # re-applies the repo's real createdAt). A normal PATCH never sends it, so
    # exclude_unset leaves it untouched.
    created_at: datetime | None = None


class ProjectResponse(CamelModel):
    uid: str
    entity_id: str | None = None
    project_id: str | None = None
    workspace_id: str | None = None
    name: dict[str, str]
    description: dict[str, str]
    short_description: dict[str, str]
    config: dict
    git_remote_config: dict | None = None
    status: str | None = None
    badges: list[dict] | None = None
    todos: list[dict] | None = None
    notes: dict | str | None = None
    readme: dict | str | None = None
    license: dict | None = None
    linked_data_source_ids: list[str] | None = None
    # Portable identities of the databases above, one per entry: the ids are
    # stripped from every export, so these are what travel.
    linked_data_source_refs: list | None = None
    organization: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    catalog_visibility: str | None = None
    # Machine-local server-path bindings (stripped from exports).
    ide_path: str | None = None
    scripts_path: str | None = None
    datasets_path: str | None = None
    origin: str
    owner_id: int | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    version: str
    created_at: datetime
    updated_at: datetime
