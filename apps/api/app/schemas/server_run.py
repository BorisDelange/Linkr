"""A server-owned run, as the page starts and reads it (services/server_runs)."""

from datetime import datetime

from pydantic import computed_field

from app.schemas.base import CamelModel


class ServerRunStart(CamelModel):
    # registry.KINDS: what to compute.
    kind: str
    # What it is the run of: a database, a mapping project, a pipeline's target…
    scope_id: str
    # The kind's spec, validated by its model (registry.Kind.spec).
    spec: dict


class ServerRunResume(CamelModel):
    # Compiled again by the page (registry.Kind.respec); None keeps the run's.
    spec: dict | None = None


class ServerRunResponse(CamelModel):
    id: str
    data_source_id: str | None = None
    kind: str
    scope_id: str
    status: str
    requested: str | None = None
    state: dict
    error: str | None = None
    job_id: str | None = None
    attempt: int
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None = None

    @computed_field
    @property
    def signature(self) -> str | None:
        """What a signed kind's run reads (`query_list.signature`), computed by the
        server: the page compares it with its own plan's before taking the run up."""
        value = self.state.get("signature")
        return value if isinstance(value, str) else None
