"""What a data catalog's disclosure audit run is given (services/server_runs/
catalog_audit): the catalog as it would be published, built by the page
(`AuditInput` in apps/web src/lib/data-catalog/audit.ts — masks and perturbation
applied), and what the results it audits are told apart by."""

from typing import Literal

from pydantic import Field

from app.schemas.base import CamelModel

Variable = Literal["concept", "period", "service", "age", "sex"]
Measure = Literal["patients", "stays", "unit_stays", "records"]
Count = int | float | None


class AuditVariable(CamelModel):
    mods: list[str]
    names: list[str]
    every_concept: bool | None = None
    level: Literal["concept", "category", "subcategory"] | None = None


class AuditCrossing(CamelModel):
    id: str
    vars: list[Variable] = Field(min_length=1, max_length=3)
    measures: list[Measure]
    # [modality index per variable…, patients, each measure…, status]
    cells: list[list[Count]]


class AuditPublished(CamelModel):
    threshold: int | float
    variables: dict[Variable, AuditVariable]
    crossings: list[AuditCrossing]


class AuditConcept(CamelModel):
    key: str
    name: str | None = None
    group: str | None = None
    patients: Count = None
    stays: Count = None
    records: Count = None


class AuditTotals(CamelModel):
    patients: int | float
    stays: int | float | None = None
    unit_stays: int | float | None = None
    records: int | float


class AuditInput(CamelModel):
    published: AuditPublished
    concepts: list[AuditConcept]
    hides_masked: bool | None = None
    every_concept: bool | None = None
    totals: AuditTotals
    threshold: int | float
    noise: int | float = Field(ge=0)


class AuditMeta(CamelModel):
    """Stamped on the audit the run gives, as `auditCatalog` stamps its own."""

    threshold: int | float
    mode: Literal["replace", "suppress"]
    noise: int | float
    results_computed_at: str


class CatalogAuditRunSpec(CamelModel):
    label: str = Field(min_length=1, max_length=255)
    input: AuditInput
    meta: AuditMeta
