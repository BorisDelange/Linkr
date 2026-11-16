"""Long computations run by the server (services/server_runs). The page starts a
run, reads it and asks for a pause or a resume; it never drives it.

Who may do what is per kind (`_SCOPES`): reading a run needs what reading its
scope needs (and its rows, what reading its database needs); starting, pausing
or resuming one needs what writing its results needs. Only its starter resumes
it: its queries read the databases as them. A run whose rows an external
database read with its starter's own login (`Kind.per_login`) is theirs alone:
no other user finds it, follows it or reads its rows."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.data_sources import (
    etl_roles,
    load_source,
    require_source_access,
    user_login,
)
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.core.refusal import refusal_detail
from app.models.data_source import DataSource
from app.models.etl_pipeline import EtlPipeline
from app.models.project import Project
from app.models.server_run import ServerRun
from app.models.user import User
from app.schemas.server_run import ServerRunResponse, ServerRunResume, ServerRunStart
from app.services import (
    cohort_access,
    cohort_service,
    data_catalog_service,
    data_source_service,
    database_binding,
    database_credential_service,
    dq_profile_service,
    dq_rule_set_service,
    mapping_project_service,
)
from app.services.server_runs import query_list, registry, runs, state

router = APIRouter(prefix="/server-runs", tags=["server-runs"])


@dataclass
class Scope:
    """Where a run of this scope runs: the database it reads as its user (a login
    the user must give first, 428), and the workspace it belongs to."""

    source: DataSource | None
    workspace_id: str | None


async def _stats_scope(db: AsyncSession, user: User, scope_id: str, write: bool, spec: dict | None) -> Scope:
    """The database's Concepts tab: its statistics write the shared profiles."""
    source = await load_source(db, scope_id, user, "databases:read")
    if write:
        await require_source_access(db, source, user, "databases:write")
    return Scope(source, source.workspace_id)


async def _extraction_scope(db: AsyncSession, user: User, scope_id: str, write: bool, spec: dict | None) -> Scope:
    """A mapping project's extraction writes the project, which must read its
    database. The database's shared profiles it writes only for a starter who
    may write the database (`_granted`)."""
    project = await mapping_project_service.get(db, scope_id)
    if project is None or not project.data_source_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such mapping project on a database")
    source = await load_source(db, project.data_source_id, user, "databases:read")
    await check_workspace_permission(db, project.workspace_id, user, "concept-mapping:write" if write else "concept-mapping:read")
    return Scope(source, project.workspace_id)


async def _etl_scope(db: AsyncSession, user: User, scope_id: str, write: bool, spec: dict | None) -> Scope:
    """A pipeline's run writes its managed target, the scope: one run per target,
    whichever pipeline. Starting one also needs the pipeline's own write access,
    and its role databases checked as a script's are (`etl_roles`)."""
    target = await load_source(db, scope_id, user, "databases:write" if write else "databases:read")
    if spec is not None:
        if not data_source_service.is_managed(target):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "the pipeline target must be a database created from a schema")
        pipeline = await db.get(EtlPipeline, str(spec.get("pipelineId") or ""))
        if pipeline is None or pipeline.target_data_source_id != target.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such pipeline on this target")
        await check_workspace_permission(db, pipeline.workspace_id, user, "etl:write")
        await etl_roles(db, target, spec.get("roles") or {}, user)
    return Scope(target, target.workspace_id)


async def _etl_quality_scope(db: AsyncSession, user: User, scope_id: str, write: bool, spec: dict | None) -> Scope:
    """A pipeline's Quality check reads its target, as its members may."""
    pipeline = await db.get(EtlPipeline, scope_id)
    if pipeline is None or not pipeline.target_data_source_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such pipeline with a target")
    await check_workspace_permission(db, pipeline.workspace_id, user, "etl:read")
    target = await load_source(db, pipeline.target_data_source_id, user, "databases:read")
    return Scope(target, pipeline.workspace_id)


async def _database_stats_scope(db: AsyncSession, user: User, scope_id: str, write: bool, spec: dict | None) -> Scope:
    """A database's statistics (`<database>:stats`) or row counts (`…:counts`): what
    reading the database allows, as the queries they replace did."""
    source_id, _, phase = scope_id.partition(":")
    if phase not in ("stats", "counts"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "a statistics run is a database's stats or counts")
    source = await load_source(db, source_id, user, "databases:read")
    return Scope(source, source.workspace_id)


async def _cohort_scope(db: AsyncSession, user: User, scope_id: str, write: bool, spec: dict | None) -> Scope:
    """A cohort's run reads one database, as running the cohort does: its own
    (a database's cohort), or one linked to its project, of the project's
    workspace. Running it is reading it — the page stores its count, as the
    cohort's writers may."""
    cohort = await cohort_service.get(db, scope_id)
    if cohort is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await cohort_access.require_owner_access(db, cohort.project_uid, cohort.owner_data_source_id, user, "cohorts:read")
    project = await db.get(Project, cohort.project_uid) if cohort.project_uid else None
    workspace_id = project.workspace_id if project else None
    if spec is None:
        return Scope(None, workspace_id)
    source_id = str((spec.get("meta") or {}).get("dataSourceId") or "")
    if cohort.owner_data_source_id:
        allowed = source_id == cohort.owner_data_source_id
    else:
        allowed = project is not None and source_id in (project.linked_data_source_ids or [])
    if not allowed:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This cohort does not run on that database")
    source = await load_source(db, source_id, user, "databases:read")
    if project is not None and database_binding.is_foreign(source, project.workspace_id):
        raise database_binding.foreign_database()
    return Scope(source, workspace_id or source.workspace_id)


async def _catalog_scope(db: AsyncSession, user: User, scope_id: str, write: bool, spec: dict | None) -> Scope:
    """A data catalog's computation writes its results, as the catalog's writers
    may, from its database read as the user — a database of its workspace, as
    storing results requires (`require_stored_local`)."""
    catalog = await data_catalog_service.get(db, scope_id)
    if catalog is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, catalog.workspace_id, user, "catalog:write" if write else "catalog:read")
    if not write:
        return Scope(None, catalog.workspace_id)
    if not catalog.data_source_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This catalog has no database")
    source = await load_source(db, catalog.data_source_id, user, "databases:read")
    await database_binding.require_stored_local(db, catalog.workspace_id, catalog.data_source_id)
    return Scope(source, catalog.workspace_id)


async def _catalog_estimate_scope(db: AsyncSession, user: User, scope_id: str, write: bool, spec: dict | None) -> Scope:
    """A data catalog's size estimate reads its database, as choosing its crossings
    does. It stores the estimates beside the catalog, which every reader of it
    sees, from a database of its workspace: the catalog's writers make them."""
    catalog = await data_catalog_service.get(db, scope_id)
    if catalog is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, catalog.workspace_id, user, "catalog:write" if write else "catalog:read")
    if not write:
        return Scope(None, catalog.workspace_id)
    if not catalog.data_source_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This catalog has no database")
    source = await load_source(db, catalog.data_source_id, user, "databases:read")
    await database_binding.require_stored_local(db, catalog.workspace_id, catalog.data_source_id)
    return Scope(source, catalog.workspace_id)


async def _catalog_audit_scope(db: AsyncSession, user: User, scope_id: str, write: bool, spec: dict | None) -> Scope:
    """A data catalog's disclosure audit reads no database; the page keeps it with
    the catalog's results, so starting one needs what storing them needs."""
    catalog = await data_catalog_service.get(db, scope_id)
    if catalog is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, catalog.workspace_id, user, "catalog:write" if write else "catalog:read")
    if write:
        await database_binding.require_stored_local(db, catalog.workspace_id, catalog.data_source_id)
    return Scope(None, catalog.workspace_id)


async def _dq_scope(db: AsyncSession, user: User, owner, label: str, write: bool, spec: dict | None) -> Scope:
    """A rule set's or a profile's run stores its history and outcome, as the
    data-quality writers may, from its own database read as the user — one of
    its workspace, as storing results requires."""
    if owner is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, owner.workspace_id, user, "data-quality:write" if write else "data-quality:read")
    if not write:
        return Scope(None, owner.workspace_id)
    if not owner.data_source_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"This {label} has no database")
    if spec is not None and spec.get("dataSourceId") != owner.data_source_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"A {label} runs on its own database")
    await check_workspace_permission(db, owner.workspace_id, user, "databases:read")
    await database_binding.require_stored_local(db, owner.workspace_id, owner.data_source_id)
    source = await load_source(db, owner.data_source_id, user, "databases:read")
    return Scope(source, owner.workspace_id)


async def _dq_rule_set_scope(db: AsyncSession, user: User, scope_id: str, write: bool, spec: dict | None) -> Scope:
    return await _dq_scope(db, user, await dq_rule_set_service.get(db, scope_id), "rule set", write, spec)


async def _dq_profile_scope(db: AsyncSession, user: User, scope_id: str, write: bool, spec: dict | None) -> Scope:
    return await _dq_scope(db, user, await dq_profile_service.get(db, scope_id), "profile", write, spec)


_SCOPES: dict[str, Callable[[AsyncSession, User, str, bool, dict | None], Awaitable[Scope]]] = {
    "stats": _stats_scope,
    "extraction": _extraction_scope,
    "etl": _etl_scope,
    "etl_quality": _etl_quality_scope,
    "database_stats": _database_stats_scope,
    "cohort_run": _cohort_scope,
    "cohort_figures": _cohort_scope,
    "catalog": _catalog_scope,
    "catalog_estimate": _catalog_estimate_scope,
    "catalog_audit": _catalog_audit_scope,
    "dq_rule_set": _dq_rule_set_scope,
    "dq_profile": _dq_profile_scope,
}

# What a kind's spec must say for its kind — beyond its model.
_CHECKS: dict[str, Callable[[dict], str | None]] = {
    "stats": lambda spec: "statistics write no source CSV" if spec.get("extraction") else None,
    "extraction": lambda spec: (
        "an extraction says what CSV it writes" if not spec.get("extraction")
        # The database's concept counts and the start over are its Concepts tab's.
        else "an extraction neither counts the database's concepts nor drops its profiles"
        if spec.get("counts") or spec.get("fresh") else None
    ),
    "catalog": lambda spec: None if spec.get("mode", "compute") == "compute" else "a catalog run computes; an estimate is a catalog_estimate run",
    "catalog_estimate": lambda spec: None if spec.get("mode") == "estimate" and spec.get("estimates") else "an estimate run says what it estimates",
}


async def _scope(db: AsyncSession, user: User, kind: str, scope_id: str, write: bool, spec: dict | None = None) -> Scope:
    """`spec`: the one a start or a resume brings, checked against the scope."""
    resolve = _SCOPES.get(kind)
    if resolve is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"no run of kind {kind!r}")
    return await resolve(db, user, scope_id, write, spec)


async def _granted(db: AsyncSession, user: User, kind: str, scope: Scope) -> dict:
    """What the starter may do beyond the scope, decided here and kept in the
    run's state, which no client writes."""
    if kind != "extraction" or scope.source is None:
        return {}
    try:
        await require_source_access(db, scope.source, user, "databases:write")
    except HTTPException:
        return {"storesProfiles": False}
    return {"storesProfiles": True}


def _principal(kind: str, scope: Scope, user: User) -> str:
    """Whose run a start makes: the user's own where the rows are their login's."""
    if scope.source is None or not registry.KINDS[kind].per_login:
        return ""
    return database_credential_service.principal_for(scope.source, user.id)


def _visible(user: User) -> tuple[str, ...]:
    """The runs a user may find: the shared ones and their own."""
    return ("", database_credential_service.user_principal(user.id))


def _require_visible(run: ServerRun, user: User) -> None:
    if run.principal not in _visible(user):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")


@router.get("/latest", response_model=ServerRunResponse | None)
async def latest_run(
    kind: str,
    scope_id: str = Query(alias="scopeId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The run going on for this kind and scope, else the last one; null when none ran."""
    await _scope(db, user, kind, scope_id, False)
    visible = _visible(user)
    return await runs.settled(
        db, await state.active(db, kind, scope_id, visible) or await state.latest(db, kind, scope_id, visible),
    )


@router.post("", response_model=ServerRunResponse, status_code=status.HTTP_202_ACCEPTED)
async def start_run(
    body: ServerRunStart,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Start a run — or answer the one already going on for this kind and scope."""
    scope = await _scope(db, user, body.kind, body.scope_id, True, body.spec)
    problem = _CHECKS.get(body.kind, lambda spec: None)(body.spec)
    if problem:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, problem)
    # Resolved now: a missing login is the user's to give (428), not a failed run.
    if scope.source is not None:
        await user_login(db, scope.source, user)
    try:
        return await runs.start(
            db, kind=body.kind, scope_id=body.scope_id, data_source_id=scope.source.id if scope.source else None,
            workspace_id=scope.workspace_id, user_id=user.id, spec=body.spec,
            granted=await _granted(db, user, body.kind, scope), principal=_principal(body.kind, scope, user),
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, refusal_detail(e)) from None


async def _load_run(db: AsyncSession, run_id: str, user: User) -> tuple[Scope, ServerRun]:
    run = await db.get(ServerRun, run_id)
    if run is None or run.kind not in registry.KINDS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    _require_visible(run, user)
    scope = await _scope(db, user, run.kind, run.scope_id, True)
    if run.kind == "etl":
        # Its scope is the target: stopping or resuming its pipeline is the pipeline's writers' too.
        pipeline = await db.get(EtlPipeline, str((run.spec or {}).get("pipeline_id") or ""))
        if pipeline is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such pipeline")
        await check_workspace_permission(db, pipeline.workspace_id, user, "etl:write")
    return scope, run


@router.post("/{run_id}/pause", response_model=ServerRunResponse)
async def pause_run(run_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Stop it where it is, to resume later."""
    _, run = await _load_run(db, run_id, user)
    return await runs.pause(db, run)


@router.post("/{run_id}/cancel", response_model=ServerRunResponse)
async def cancel_run(run_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Stop it for good."""
    _, run = await _load_run(db, run_id, user)
    return await runs.pause(db, run, "cancel")


def _stored_spec(run: ServerRun) -> dict:
    """The run's spec as the page sent it."""
    try:
        return registry.KINDS[run.kind].spec.model_validate(run.spec).model_dump(by_alias=True)
    except ValidationError:
        raise HTTPException(status.HTTP_409_CONFLICT, "this run was started by an older server: start it again") from None


@router.post("/{run_id}/resume", response_model=ServerRunResponse)
async def resume_run(
    run_id: str,
    body: ServerRunResume | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Go on where it stopped — with a spec compiled again, for a kind that takes one."""
    spec = body.spec if body else None
    scope, run = await _load_run(db, run_id, user)
    if run.user_id != user.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the user who started this run can resume it; start it again instead",
        )
    # Checked as a start's: what it reads may have changed hands while it waited.
    scope = await _scope(db, user, run.kind, run.scope_id, True, spec if spec is not None else _stored_spec(run))
    if scope.source is not None:
        await user_login(db, scope.source, user)
    try:
        return await runs.resume(db, run, spec, granted=await _granted(db, user, run.kind, scope))
    except ValueError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, refusal_detail(e)) from None
    except IntegrityError:
        raise HTTPException(status.HTTP_409_CONFLICT, "another run of this scope is going on") from None


@router.get("/{run_id}/results/{key}")
async def run_result(run_id: str, key: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """The rows one query of a list returned (`query_list` kinds), read as the run is."""
    run = await db.get(ServerRun, run_id)
    if run is None or run.kind not in registry.KINDS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    _require_visible(run, user)
    await _scope(db, user, run.kind, run.scope_id, False)
    if run.data_source_id:
        # Its rows are the database's: a reader of the scope alone (a cohort's) does not get them.
        await load_source(db, run.data_source_id, user, "databases:read")
    rows = await asyncio.to_thread(query_list.read_result, run.id, key) if query_list.KEY.fullmatch(key) else None
    if rows is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such result")
    return {"rows": rows}
