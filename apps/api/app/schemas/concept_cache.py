from datetime import datetime

from app.schemas.base import CamelModel


class ConceptCacheRefreshRequest(CamelModel):
    """The full (unpaginated) list SQL the frontend built, materialized to Parquet."""

    select_sql: str


class ConceptCacheStatus(CamelModel):
    exists: bool
    # Epoch seconds of the cache file's mtime — the "last refreshed" time.
    refreshed_at: float | None = None


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
