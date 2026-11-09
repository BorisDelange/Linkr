"""What a server-owned data catalog computation (kind `catalog`) or crossings'
size estimate (kind `catalog_estimate`) is given (services/server_runs/catalog),
compiled by the page (apps/web src/lib/duckdb/catalog-run-spec.ts):
the catalog's plan (`CatalogPlan` in catalog-compute.ts), every query a template
with its class relations in and the values that depend on earlier results as
tokens (`fill_catalog_sql`)."""

from typing import Literal

from pydantic import Field

from app.schemas.base import CamelModel

Variable = Literal["concept", "period", "service", "age", "sex"]


class CatalogConceptCount(CamelModel):
    dict_key: str
    sql: str


class CatalogCrossingTemplate(CamelModel):
    variables: list[Variable] = Field(min_length=1, max_length=3)
    # None: nothing to query (the concept marginal comes from its ranking, or a
    # variable this mapping cannot express).
    sql: str | None = None


class CatalogEstimateTemplate(CamelModel):
    variables: list[Variable] = Field(min_length=1, max_length=3)
    # Where it is stored (`estimateKey`: the database, the crossed variables'
    # parameters, the threshold), so an estimate outlives an unrelated change.
    key: str = Field(min_length=1, max_length=2000)
    sql: str


class CatalogConceptPlan(CamelModel):
    level: Literal["concept", "category", "subcategory"]
    scope: Literal["all", "top"]
    top_n: int
    # Whether the concept list reads a category / subcategory column.
    category_column: bool = False
    subcategory_column: bool = False


class CatalogServicePlan(CamelModel):
    grouping: Literal["all", "top", "manual"]
    top_n: int


class CatalogPeriodPlan(CamelModel):
    granularity: Literal["month", "quarter", "year"]
    step: float = 1


class CatalogModalityPlan(CamelModel):
    # The age bracket labels, in order.
    age: list[str] | None = None
    sex: bool = False
    period: CatalogPeriodPlan | None = None
    service: bool = False
    concept: bool = False


class CatalogRunSpec(CamelModel):
    label: str = Field(min_length=1, max_length=255)
    # Start over; else a paused computation's stored results are resumed.
    fresh: bool = False
    mode: Literal["compute", "estimate"] = "compute"
    # The estimate mode's queries, after the rankings.
    estimates: list[CatalogEstimateTemplate] = []
    size_sql: str
    bounds_sql: str | None = None
    slice_rows: int = Field(ge=1)
    max_slices: int = Field(ge=1, le=64)
    concept_chunk: int = Field(ge=1)
    concept_counts: list[CatalogConceptCount] = Field(min_length=1)
    totals_sql: str
    service_rank_sql: str | None = None
    concept_rank_sql: str | None = None
    crossings: list[CatalogCrossingTemplate]
    dict_keys: list[str]
    concept: CatalogConceptPlan | None = None
    service: CatalogServicePlan | None = None
    visits: bool = True
    modalities: CatalogModalityPlan = CatalogModalityPlan()
