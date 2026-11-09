from typing import Literal

from pydantic import Field, model_validator

from app.schemas.base import CamelModel

# Where the server puts a batch's ids, and a page's ranking positions, in the
# SQL the client compiled (`concept_runs.loop.fill`).
IDS_TOKEN = "/*LINKR_IDS*/"
POSITIONS_TOKEN = "/*LINKR_POSITIONS*/"


class RunSort(CamelModel):
    key: Literal["id", "code", "name", "records", "patients"]
    direction: Literal["asc", "desc"]


class EventSpec(CamelModel):
    """One event table a dictionary's concepts are profiled in."""

    relation: str
    # Reads the concept counts' records of this relation instead of `count_sql`
    # (concept_cache_fs.counted_records); None when they cannot stand in.
    signature: str | None = None
    count_sql: str
    # One batch's profile, `IDS_TOKEN` standing for its ids.
    batch_sql: str
    # The scalar row of a concept with no record in this table.
    empty_scalar: dict
    # The sections its batch computes (the dictionary's that this table answers).
    sections: list[str]


class DictionarySpec(CamelModel):
    dict_key: str
    ids_sql: str
    # A page of the dictionary, `IDS_TOKEN` and `POSITIONS_TOKEN` standing for
    # its ids and their ranking.
    page_sql: str
    events: list[EventSpec] = Field(min_length=1)
    # The sections its profiles hold (the asked ones its tables can answer).
    sections: list[str]


class CountItem(CamelModel):
    key: str
    sql: str


class CountStep(CamelModel):
    step: Literal["records", "patients"]
    items: list[CountItem]


class CountSpec(CamelModel):
    """The concept counts before the statistics (the Concepts tab): the units
    still to count, an assembly among them, then `final_assemble_sql`."""

    run_id: str
    steps: list[CountStep]
    final_assemble_sql: str


class ExtractionSpec(CamelModel):
    """A mapping project's extraction also writes its source CSV."""

    # `fileSourceData` as the project stores it, `totalRowCount` set at each save.
    file_source_data: dict
    dictionary_keys: list[str]


class RunStepName(CamelModel):
    key: Literal["records", "patients", "stats"]
    label: str


class RunSpec(CamelModel):
    label: str
    # The steps the job shows under its row, in order, named in the app's
    # language: the counts' and the statistics' of a run doing several.
    steps: list[RunStepName] = Field(default_factory=list)
    # The data the profiles describe (`dataFingerprint`), measured at start.
    fingerprint: str
    options: dict
    sort: RunSort
    only_with_records: bool
    # Rank on the counts (a volume sort, only concepts with records, several
    # event tables); otherwise the dictionary orders itself.
    needs_counts: bool
    # Profiles at all (`computesMetadata`), and the count columns of the CSV.
    metadata: bool
    count_columns: bool
    data_source_label: str | None = None
    # None for counts alone.
    dictionaries: list[DictionarySpec] = Field(default_factory=list)
    counts: CountSpec | None = None
    extraction: ExtractionSpec | None = None
    # Start over: the database's stored profiles go first (the Concepts tab).
    fresh: bool = False

    @model_validator(mode="after")
    def _something_to_run(self):
        if not self.dictionaries and self.counts is None:
            raise ValueError("a run counts or profiles something")
        return self
