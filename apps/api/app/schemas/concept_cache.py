from datetime import datetime

from pydantic import Field

from app.schemas.base import CamelModel


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
    # Whether it holds any of the requested concepts, and which.
    holds: bool
    held: list[str] = Field(default_factory=list)


class ConceptRelationsResult(CamelModel):
    relations: list[CountedRelation]


class RelationRecordsRequest(CamelModel):
    relation: str = Field(min_length=1, max_length=200)
    signature: str = Field(min_length=1, max_length=100)


class RelationRecord(CamelModel):
    concept_id: str
    record_count: int


class RelationRecordsResult(CamelModel):
    # None: the last run did not count this relation under this signature.
    counts: list[RelationRecord] | None


class ConceptStatsSave(CamelModel):
    stats: dict


class ConceptStatsResponse(CamelModel):
    data_source_id: str
    concept_id: int
    stats: dict
    updated_at: datetime


# --- Concept profiles (concept_profile_service) ------------------------------

# The profile rows are the browser's (`profile-store.ts` StoredProfile): they
# travel as it writes them, camelCase, and are stored as they come.

class ConceptProfilesRead(CamelModel):
    dict_key: str = Field(max_length=200)
    concept_ids: list[int] = Field(max_length=20_000)
    # Without the profiles' JSON.
    meta: bool = False


class ConceptProfilesWrite(CamelModel):
    profiles: list[dict] = Field(max_length=5_000)


class ConceptProfilesResult(CamelModel):
    profiles: list[dict]


class ConceptProfilesRunSave(CamelModel):
    """The Concepts tab's profiling run (null: forget it)."""

    run: dict | None = None
    computed_at: str = Field(default="", max_length=40)


class ConceptProfilesSummary(CamelModel):
    count: int
    last_computed_at: str | None = None
    sections: dict[str, int]
    fingerprints: dict[str, int]
    run: dict | None = None
