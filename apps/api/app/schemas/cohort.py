from datetime import datetime

from pydantic import model_validator

from app.core.path_ids import SegmentId
from app.schemas.base import CamelModel


def served_materialization(materialization: dict | None, data_source_id: str | None) -> dict | None:
    """A cohort's frozen membership, unless it was frozen on another database than
    the one the cohort now runs on: its ids are then not that database's. One
    frozen before the database was recorded is taken as the cohort's."""
    if materialization is None:
        return None
    frozen_on = materialization.get("dataSourceId")
    if frozen_on is not None and data_source_id is not None and frozen_on != data_source_id:
        return None
    return materialization


class CohortCreate(CamelModel):
    id: SegmentId
    # Exactly one owner: a project, or a database (the database page's cohorts).
    project_uid: str | None = None
    owner_data_source_id: str | None = None
    # LocalizedString. `str` is still accepted so older clients and seed
    # manifests that post a bare name keep working (LocalizedText reads it back).
    name: dict | str = ""
    description: dict | str | None = None
    data_source_id: str | None = None
    data_source_ref: dict | None = None
    level: str
    criteria_tree: dict = {}
    custom_sql: str | None = None
    result_count: int | None = None
    attrition: list | None = None
    materialization: dict | None = None
    schema_version: int = 5
    # Creation date preserved on import round-trip; absent → server_default stamps now.
    created_at: datetime | None = None
    version: str = "0.1.0"


class CohortUpdate(CamelModel):
    name: dict | str | None = None
    description: dict | str | None = None
    data_source_id: str | None = None
    data_source_ref: dict | None = None
    level: str | None = None
    criteria_tree: dict | None = None
    custom_sql: str | None = None
    result_count: int | None = None
    attrition: list | None = None
    materialization: dict | None = None
    schema_version: int | None = None
    version: str | None = None
    # Restored on import/clone so the original creation date survives a git
    # round-trip; a normal PATCH never sends it (exclude_unset leaves it alone).
    created_at: datetime | None = None


class CohortResponse(CamelModel):
    id: str
    project_uid: str | None = None
    owner_data_source_id: str | None = None
    name: dict | str
    description: dict | str | None = None
    data_source_id: str | None = None
    data_source_ref: dict | None = None
    level: str
    criteria_tree: dict
    custom_sql: str | None = None
    result_count: int | None = None
    attrition: list | None = None
    materialization: dict | None = None
    # Server-written only (cohort_derive_service): what this cohort was derived
    # into on this instance, which a rebuild trusts.
    derivations: list | None = None
    schema_version: int
    created_at: datetime
    updated_at: datetime
    version: str

    @model_validator(mode="after")
    def _only_this_databases_members(self) -> "CohortResponse":
        self.materialization = served_materialization(self.materialization, self.data_source_id)
        return self


class CohortMaterializeRequest(CamelModel):
    # The cohort's membership query (`id`, `patient_id`), as the criteria builder
    # writes it (buildCohortMembershipSql). Runs read-only against the database.
    membership_sql: str
    # The database it runs on; default the cohort's own.
    data_source_id: str | None = None
