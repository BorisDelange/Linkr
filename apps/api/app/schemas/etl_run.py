"""What a server-owned ETL pipeline run is given (services/server_runs/etl.py),
compiled by the page (apps/web features/warehouse/etl/run-pipeline-sql.ts
`compileEtlRunSpec`)."""

from pydantic import Field, field_validator

from app.schemas.base import CamelModel
from app.schemas.data_source import EtlRunRequest


class EtlStep(CamelModel):
    file_id: str
    name: str
    # The script as it runs — role prefixes resolved as the page resolves them;
    # None for a script left out (disabled, empty), recorded as skipped.
    sql: str | None = None


class EtlRunSpec(CamelModel):
    label: str = Field(min_length=1, max_length=255)
    pipeline_id: str
    # The databases attached beside the target, read-only, by role (`source`, `vocab`).
    roles: dict[str, str] = {}
    steps: list[EtlStep] = Field(min_length=1)
    # The `mapping.<name>` exports the scripts read, as CSV text (EtlRunRequest).
    mapping_data: dict[str, str] = {}

    @field_validator("roles")
    @classmethod
    def _normalise_roles(cls, value: dict[str, str]) -> dict[str, str]:
        return EtlRunRequest._normalise_roles(value)
