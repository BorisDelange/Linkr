"""The kinds of server run: for each, the spec the page compiles, the executor
that runs it, its first state and what its job is shown under. Who may start,
read or stop one is the routes' (`routes/server_runs.py`)."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from pydantic import BaseModel

from app.models.data_source import DataSource
from app.models.server_run import ServerRun
from app.schemas.catalog_audit_run import CatalogAuditRunSpec
from app.schemas.catalog_run import CatalogRunSpec
from app.schemas.concept_run import RunSpec
from app.schemas.etl_run import EtlRunSpec
from app.schemas.query_list import QueryListSpec
from app.services.execution import jobs
from app.services.server_runs.catalog.executor import CatalogExecutor
from app.services.server_runs.catalog_audit.executor import CatalogAuditExecutor
from app.services.server_runs.concepts.executor import ConceptExecutor
from app.services.server_runs.etl import EtlExecutor
from app.services.server_runs.executor import RunExecutor
from app.services.server_runs.query_list import QueryListExecutor


async def _database_entity(db, run: ServerRun) -> jobs.Entity | None:
    if run.data_source_id is None:
        return None
    source = await db.get(DataSource, run.data_source_id)
    return jobs.Entity("database", run.data_source_id, jobs._name_of(source.name) if source else "")


async def _mapping_project_entity(db, run: ServerRun) -> jobs.Entity | None:
    from app.models.mapping_project import MappingProject

    project = await db.get(MappingProject, run.scope_id)
    if project is None:
        return await _database_entity(db, run)
    return jobs.Entity("mapping_project", project.id, jobs._name_of(project.name))


@dataclass(frozen=True)
class Kind:
    spec: type[BaseModel]
    executor: type[RunExecutor]
    entity: Callable[..., Awaitable[jobs.Entity | None]] = _database_entity
    initial: Callable[[BaseModel], dict] = field(default=lambda spec: {})
    # Taken back by itself after a server restart; one whose cut step left
    # partial writes waits for its user instead.
    resume_on_startup: bool = True
    # A resume may bring a spec compiled again (scripts fixed while it waited):
    # `respec(state, spec)` is the checkpoint carried over to it.
    respec: Callable[[dict, BaseModel], dict] | None = None


def _concepts_initial(spec: RunSpec) -> dict:
    return {"stage": "counts" if spec.counts else "ranking"}


async def _pipeline_entity(db, run: ServerRun) -> jobs.Entity | None:
    from app.models.etl_pipeline import EtlPipeline

    pipeline = await db.get(EtlPipeline, (run.spec or {}).get("pipeline_id") or "")
    if pipeline is None:
        return await _database_entity(db, run)
    return jobs.Entity("etl_pipeline", pipeline.id, jobs._name_of(pipeline.name))


async def _scope_pipeline_entity(db, run: ServerRun) -> jobs.Entity | None:
    from app.models.etl_pipeline import EtlPipeline

    pipeline = await db.get(EtlPipeline, run.scope_id)
    if pipeline is None:
        return await _database_entity(db, run)
    return jobs.Entity("etl_pipeline", pipeline.id, jobs._name_of(pipeline.name))


async def _catalog_entity(db, run: ServerRun) -> jobs.Entity | None:
    from app.models.data_catalog import DataCatalog

    catalog = await db.get(DataCatalog, run.scope_id)
    if catalog is None:
        return await _database_entity(db, run)
    return jobs.Entity("data_catalog", catalog.id, jobs._name_of(catalog.name))


async def _cohort_entity(db, run: ServerRun) -> jobs.Entity | None:
    from app.models.cohort import Cohort

    cohort = await db.get(Cohort, run.scope_id)
    if cohort is None:
        return await _database_entity(db, run)
    return jobs.Entity("cohort", cohort.id, jobs._name_of(cohort.name))


def _query_list_initial(spec: QueryListSpec) -> dict:
    return {"next": 0, "meta": spec.meta}


def _etl_respec(state: dict, spec) -> dict:
    """The scripts left, compiled again — maybe only those: the run goes on at the
    first one not done, found by its file in the new steps."""
    file_ids = state.get("fileIds") or []
    at = state.get("next", 0)
    if at >= len(file_ids):
        return state
    steps = [step.file_id for step in spec.steps]
    pending = file_ids[at]
    return {**state, "next": steps.index(pending) if pending in steps else 0, "fileIds": steps}


KINDS: dict[str, Kind] = {
    "stats": Kind(RunSpec, ConceptExecutor, initial=_concepts_initial),
    "extraction": Kind(RunSpec, ConceptExecutor, entity=_mapping_project_entity, initial=_concepts_initial),
    # One per target database: a DuckDB file has one writer.
    "etl": Kind(
        EtlRunSpec, EtlExecutor, entity=_pipeline_entity, initial=lambda spec: {"next": 0, "scripts": [], "pipelineId": spec.pipeline_id},
        resume_on_startup=False, respec=_etl_respec,
    ),
    # A pipeline's Quality check, its concept comparison: scope the pipeline.
    "etl_quality": Kind(QueryListSpec, QueryListExecutor, entity=_scope_pipeline_entity, initial=_query_list_initial),
    # A database's statistics or its tables' row counts: scope `<database>:stats|counts`.
    "database_stats": Kind(QueryListSpec, QueryListExecutor, initial=_query_list_initial),
    # A data catalog's computation: scope the catalog, which reads its database.
    "catalog": Kind(CatalogRunSpec, CatalogExecutor, entity=_catalog_entity),
    # The size estimate of its crossings, the same executor's other mode: scope the catalog.
    "catalog_estimate": Kind(CatalogRunSpec, CatalogExecutor, entity=_catalog_entity),
    # Its disclosure audit, of what it would publish: scope the catalog, CPU only.
    "catalog_audit": Kind(
        CatalogAuditRunSpec, CatalogAuditExecutor, entity=_catalog_entity,
        initial=lambda spec: {"next": 0, "meta": spec.meta.model_dump(by_alias=True)},
    ),
    # A cohort's members, count and attrition: scope the cohort.
    "cohort_run": Kind(QueryListSpec, QueryListExecutor, entity=_cohort_entity, initial=_query_list_initial),
    # Its report's and its Statistics tab's figures: scope the cohort.
    "cohort_figures": Kind(QueryListSpec, QueryListExecutor, entity=_cohort_entity, initial=_query_list_initial),
}
