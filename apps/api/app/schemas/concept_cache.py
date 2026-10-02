from datetime import datetime

from app.schemas.base import CamelModel


class ConceptCacheAssembleRequest(CamelModel):
    """The full (unpaginated) list SQL the frontend built: the dictionaries joined
    to the units done so far, through the view `memory.main._concept_counts`."""

    select_sql: str


class ConceptRunStatus(CamelModel):
    """The last counting run: its manifest (owned by the client), the units done,
    and when the last one was written (epoch seconds)."""

    manifest: dict
    done_units: list[str]
    last_unit_at: float | None = None


class ConceptCacheStatus(CamelModel):
    exists: bool
    # Epoch seconds of the cache file's mtime — the "last refreshed" time.
    refreshed_at: float | None = None
    run: ConceptRunStatus | None = None


class ConceptRunStart(CamelModel):
    manifest: dict
    # Drop the units already done: a fresh run rather than a resume.
    reset: bool = False


class ConceptUnitRequest(CamelModel):
    """One counting unit: a single SELECT whose rows are kept as the unit's file.
    `query_id` makes it cancellable through `/query/cancel`."""

    sql: str
    query_id: str | None = None


class ConceptPageRequest(CamelModel):
    """A page/filter/sort query run against the cached Parquet (view `concepts`)."""

    sql: str


class ConceptPageResult(CamelModel):
    rows: list[dict]


class ConceptStatsSave(CamelModel):
    stats: dict


class ConceptStatsResponse(CamelModel):
    data_source_id: str
    concept_id: int
    stats: dict
    updated_at: datetime
