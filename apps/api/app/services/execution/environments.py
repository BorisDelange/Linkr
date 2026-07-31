"""Project environments — the interpreter + package set a project's code runs in.

One environment per (project, language). This service resolves it, seeding a
``system`` environment lazily on first access (get-or-create) so existing
projects — which predate the table — keep resolving to today's shared
interpreter with zero behaviour change.

Managed (uv/renv) provisioning and package endpoints land in later steps; for
now every resolved environment is ``system`` and carries no interpreter override,
so ``kernel._make`` falls back to ``sys.executable`` / system ``Rscript``.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from app.models.environment import Environment


async def resolve(db: AsyncSession, project_uid: str, language: str) -> Environment:
    """The project's environment for `language`, creating a `system` one if none
    exists yet. Concurrency-safe: a racing insert (unique on project+language) is
    caught and the existing row re-read."""
    env = await _find(db, project_uid, language)
    if env is not None:
        return env
    env = Environment(
        project_uid=project_uid, language=language, kind="system", status="ready"
    )
    db.add(env)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        env = await _find(db, project_uid, language)
        assert env is not None  # a concurrent insert won the race — reuse it
        return env
    await db.refresh(env)
    return env


async def _find(
    db: AsyncSession, project_uid: str, language: str
) -> Environment | None:
    result = await db.execute(
        select(Environment)
        .where(Environment.project_uid == project_uid)
        .where(Environment.language == language)
    )
    return result.scalar_one_or_none()


async def list_for_project(db: AsyncSession, project_uid: str) -> list[Environment]:
    """Both languages' environments, seeding any missing one as `system` so the UI
    always shows a Python and an R entry."""
    return [
        await resolve(db, project_uid, "python"),
        await resolve(db, project_uid, "r"),
    ]


async def add_packages(
    db: AsyncSession, project_uid: str, language: str, packages: list[str]
) -> Environment:
    """Add packages to a project's environment (declarative: manifest + re-lock).
    Adding a package promotes a `system` env to `managed` — it now has a spec to
    build. The venv itself is (re)built separately via ``build`` (manual)."""
    env = await resolve(db, project_uid, language)
    _provisioner(language).add_packages(project_uid, packages)
    return await _mark_managed(db, env)


async def remove_package(
    db: AsyncSession, project_uid: str, language: str, package: str
) -> Environment:
    env = await resolve(db, project_uid, language)
    _provisioner(language).remove_package(project_uid, package)
    return await _mark_managed(db, env)


def list_packages(project_uid: str, language: str) -> list[dict]:
    return _provisioner(language).list_packages(project_uid)


async def build(
    db: AsyncSession, project_uid: str, language: str, on_log=None
) -> Environment:
    """Materialise the env's venv/library from its lockfile (manual, explicit).
    Flips status building → ready/error and records the resolved interpreter.
    ``on_log`` (if given) receives each build output line — used by the job runner
    to stream into the job's log tail."""
    prov = _provisioner(language)
    env = await resolve(db, project_uid, language)
    env.status = "building"
    await db.commit()
    result = await prov.build(project_uid, on_log=on_log)
    env = await resolve(db, project_uid, language)
    if result.ok:
        env.status = "ready"
        env.kind = "managed"
        env.interpreter_path = str(prov.venv_python(project_uid))
    else:
        env.status = "error"
    await db.commit()
    await db.refresh(env)
    return env


async def _mark_managed(db: AsyncSession, env: Environment) -> Environment:
    if env.kind != "managed":
        env.kind = "managed"
    # A spec change invalidates a previously-built venv until the next build.
    env.status = "draft"
    await db.commit()
    await db.refresh(env)
    return env


def _provisioner(language: str):
    if language == "python":
        from app.services.execution import uv_provisioner

        return uv_provisioner
    # renv provisioner lands in step 5; until then R stays system-only.
    raise ValueError(f"No managed-environment provisioner for language: {language}")
