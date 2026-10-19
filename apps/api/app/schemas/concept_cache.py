from datetime import datetime

from pydantic import Field

from app.schemas.base import CamelModel
from app.schemas.data_source import QueryJobItem


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


class ConceptUnitsJobRequest(CamelModel):
    """Counting units of run `run_id` run one after the other as a job, each kept
    as its unit's file; a key starting `assemble-` writes the list from the units
    done so far instead (services/data/query_jobs.write_concept_units)."""

    label: str = Field(min_length=1, max_length=255)
    run_id: str
    units: list[QueryJobItem] = Field(min_length=1, max_length=10_000)


class ConceptPageRequest(CamelModel):
    """A page/filter/sort query run against the cached Parquet (view `concepts`)."""

    sql: str


class ConceptPageResult(CamelModel):
    rows: list[dict]


class ConceptRelationsRequest(CamelModel):
    concept_ids: list[int | str] = Field(min_length=1, max_length=10_000)


class CountedRelation(CamelModel):
    """An event relation the last counting run counted the records of."""

    relation: str
    # Of the relation's SQL when it was counted: a mapping changed since makes it stale.
    signature: str | None = None
    # Whether it holds any of the requested concepts.
    holds: bool


class ConceptRelationsResult(CamelModel):
    relations: list[CountedRelation]


class ConceptStatsDictionary(CamelModel):
    """A dictionary with values to describe, and its value-bearing event relations."""

    dict_key: str = Field(min_length=1, max_length=255)
    relations: list[str] = Field(min_length=1, max_length=200)


class ConceptStatsPlanRequest(CamelModel):
    dicts: list[ConceptStatsDictionary] = Field(max_length=200)
    max_rows: int = Field(ge=1)


class ConceptStatsRange(CamelModel):
    """The concepts of `dict_key` whose id lies in [lo, hi], a null bound open."""

    dict_key: str
    lo: int | None = None
    hi: int | None = None


class ConceptStatsPlanResult(CamelModel):
    ranges: list[ConceptStatsRange]


class ConceptStatsSave(CamelModel):
    stats: dict


class ConceptStatsResponse(CamelModel):
    data_source_id: str
    concept_id: int
    stats: dict
    updated_at: datetime
