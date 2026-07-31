"""Project environments (managed Python/R packages) + long-running jobs.

Separate from the /execute router because these live at /projects/{uid}/… and
/jobs/… (not under /execute). Package ops are gated on ide:write, reads on
ide:read, matching the IDE permission model. Build runs as a tracked, cancellable
job (see services.execution.jobs); a env's spec (manifest+lockfile) is versioned
in the project git while the materialised venv/library is machine-local."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session, get_db
from app.core.deps import get_current_user
from app.core.permissions import has_project_permission
from app.models.job import Job
from app.models.project import Project
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.execution import (
    AddPackagesRequest,
    EnvironmentResponse,
    JobResponse,
    PackageResponse,
)
from app.services import project_fs
from app.services.execution import environments, jobs
from app.services.execution.uv_provisioner import ProvisionError

router = APIRouter(tags=["environments"])


def _env_response(env) -> EnvironmentResponse:
    return EnvironmentResponse.model_validate(env, from_attributes=True)


async def _require_ide(db: AsyncSession, project_uid: str, user: User, action: str) -> Project:
    """Gate an environment operation on the matching ide:<action> permission.
    Returns the project so callers can read e.g. its workspace."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if not await has_project_permission(db, project, user, f"ide:{action}"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not permitted on this project")
    project_fs.prime_binding(project_uid, project.ide_path, project.scripts_path, project.datasets_path)
    return project


def _valid_language(language: str) -> str:
    if language not in ("python", "r"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown language: {language}")
    return language


@router.get("/projects/{project_uid}/environments", response_model=list[EnvironmentResponse])
async def list_environments(
    project_uid: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The project's Python and R environments (each seeded `system` if absent)."""
    await _require_ide(db, project_uid, user, "read")
    envs = await environments.list_for_project(db, project_uid)
    return [_env_response(e) for e in envs]


@router.get(
    "/projects/{project_uid}/environments/{language}/packages",
    response_model=list[PackageResponse],
)
async def list_env_packages(
    project_uid: str,
    language: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_ide(db, project_uid, user, "read")
    _valid_language(language)
    return [PackageResponse(**p) for p in environments.list_packages(project_uid, language)]


@router.post(
    "/projects/{project_uid}/environments/{language}/packages",
    response_model=EnvironmentResponse,
)
async def add_env_packages(
    project_uid: str,
    language: str,
    body: AddPackagesRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add package(s): rewrite the manifest and re-lock. Build is a separate,
    explicit step (POST …/build) — nothing is materialised here."""
    await _require_ide(db, project_uid, user, "write")
    _valid_language(language)
    if not body.packages:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No packages given")
    try:
        env = await environments.add_packages(db, project_uid, language, body.packages)
    except (ValueError, ProvisionError) as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    return _env_response(env)


@router.delete(
    "/projects/{project_uid}/environments/{language}/packages/{package}",
    response_model=EnvironmentResponse,
)
async def remove_env_package(
    project_uid: str,
    language: str,
    package: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_ide(db, project_uid, user, "write")
    _valid_language(language)
    try:
        env = await environments.remove_package(db, project_uid, language, package)
    except (ValueError, ProvisionError) as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    return _env_response(env)


@router.post(
    "/projects/{project_uid}/environments/{language}/preset",
    response_model=EnvironmentResponse,
)
async def install_preset(
    project_uid: str,
    language: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Record the workspace's default data-science package list into this env
    (manifest + re-lock; no build). Build separately or on first run."""
    project = await _require_ide(db, project_uid, user, "write")
    _valid_language(language)
    workspace = await db.get(Workspace, project.workspace_id) if project.workspace_id else None
    packages = environments.preset_for(
        workspace.default_env_packages if workspace else None, language
    )
    try:
        env = await environments.install_preset(db, project_uid, language, packages)
    except (ValueError, ProvisionError) as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    return _env_response(env)


@router.post(
    "/projects/{project_uid}/environments/{language}/upgrade",
    response_model=EnvironmentResponse,
)
async def upgrade_env_packages(
    project_uid: str,
    language: str,
    package: str | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Re-lock a package (query `?package=`) or all packages to newer versions, then
    mark the env for rebuild. No build here."""
    await _require_ide(db, project_uid, user, "write")
    _valid_language(language)
    try:
        env = await environments.upgrade(db, project_uid, language, package)
    except (ValueError, ProvisionError) as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    return _env_response(env)


@router.post(
    "/projects/{project_uid}/environments/{language}/build",
    response_model=JobResponse,
)
async def build_environment(
    project_uid: str,
    language: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Kick off a manual environment build as a tracked, cancellable job. Returns
    the queued job immediately; poll GET /projects/{uid}/jobs for progress and the
    env's status. The build runs behind the bounded executor (won't block others)."""
    await _require_ide(db, project_uid, user, "write")
    _valid_language(language)
    label = f"Build {environments.language_label(language)} environment"
    job = await jobs.create(db, project_uid, user.id, kind="build", label=label)

    async def body(handle: jobs.JobHandle) -> None:
        buffer: list[str] = []

        def on_log(line: str) -> None:
            buffer.append(line)

        async with async_session() as job_db:
            await environments.build(job_db, project_uid, language, on_log=on_log)
        if buffer:
            await handle.log("\n".join(buffer[-200:]))

    jobs.launch(job.id, body)
    return JobResponse.model_validate(job, from_attributes=True)


@router.get("/projects/{project_uid}/jobs", response_model=list[JobResponse])
async def list_jobs(
    project_uid: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The caller's recent jobs for a project (queued/running/finished), newest
    first — feeds the StatusBar jobs panel. Per-user."""
    await _require_ide(db, project_uid, user, "read")
    rows = await jobs.list_active(db, project_uid, user.id)
    return [JobResponse.model_validate(j, from_attributes=True) for j in rows]


@router.delete("/projects/{project_uid}/jobs", status_code=status.HTTP_204_NO_CONTENT)
async def clear_finished_jobs(
    project_uid: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove the caller's finished jobs (done/error/cancelled) for a project — the
    panel's 'clear all'. Active jobs are kept."""
    await _require_ide(db, project_uid, user, "read")
    await jobs.clear_finished(db, project_uid, user.id)


@router.post("/jobs/{job_id}/cancel", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_job(
    job_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Cancel a live job. Only the owner may cancel it."""
    job = await db.get(Job, job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    if job.user_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your job")
    await jobs.cancel(db, job)
