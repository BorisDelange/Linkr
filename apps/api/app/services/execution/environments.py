"""Project environments — the interpreter + package set a project's code runs in.

One environment per (project, language), always project-managed (there is no
user-visible "system" tier). Its declarative spec (manifest + lockfile) lives
under ``environments/<lang>/`` and is versioned in git.

Resolution is lazy (get-or-create). A freshly-seeded env has **no packages**, so
it resolves to the shared interpreter and needs no build — code runs immediately.
Adding a package (or importing a project whose lockfile came down from git) marks
it ``draft`` ("needs build"); the build then materialises an isolated venv/library.

The ``kind`` column is kept for internal state only:
  - ``system``  → no packages declared → shared interpreter, nothing to build;
  - ``managed`` → packages declared → isolated venv/library once built.
The UI never shows this distinction — it shows packages + a build/ready state.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from app.models.environment import Environment


async def resolve(db: AsyncSession, project_uid: str, language: str) -> Environment:
    """The project's environment for `language`, creating one if none exists yet.

    Seeds ``managed``/``draft`` when a committed lockfile is already on disk (a
    cloned/imported project — shows as "needs build" with no import-time wiring),
    otherwise an empty ``system`` env that resolves to the shared interpreter and
    needs no build. Concurrency-safe: a racing insert (unique on project+language)
    is caught and the row re-read."""
    env = await _find(db, project_uid, language)
    if env is not None:
        return env
    imported = _has_disk_spec(project_uid, language)
    env = Environment(
        project_uid=project_uid,
        language=language,
        kind="managed" if imported else "system",
        status="draft" if imported else "ready",
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


# Built-in data-science defaults used when a workspace hasn't customised its
# preset (Workspace Settings → Default environments). Kept deliberately small so
# a first build is quick; the user adds more per project.
def language_label(language: str) -> str:
    """Display name for a language ('Python' / 'R'), for job labels etc."""
    return {"python": "Python", "r": "R"}.get(language, language)


DEFAULT_PACKAGES: dict[str, list[str]] = {
    "python": ["pandas", "numpy", "matplotlib", "plotly", "scikit-learn", "duckdb"],
    "r": ["dplyr", "ggplot2", "tidyr", "readr", "data.table"],
}


def preset_for(workspace_default: dict | None, language: str) -> list[str]:
    """The default package list for a language: the workspace's customised list if
    set, else the built-in data-science defaults."""
    if workspace_default and isinstance(workspace_default.get(language), list):
        return [str(p) for p in workspace_default[language]]
    return DEFAULT_PACKAGES.get(language, [])


async def install_preset(
    db: AsyncSession, project_uid: str, language: str, packages: list[str]
) -> Environment:
    """Record a preset package list into the project's env (manifest + re-lock),
    marking it draft. No build here — the user builds explicitly, or the first run
    auto-builds. A no-op for an empty preset."""
    if not packages:
        return await resolve(db, project_uid, language)
    return await add_packages(db, project_uid, language, packages)


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


async def upgrade(
    db: AsyncSession, project_uid: str, language: str, package: str | None = None
) -> Environment:
    """Re-lock one package (or all) to a newer version and mark the env draft so the
    user rebuilds. `package=None` = upgrade all."""
    env = await resolve(db, project_uid, language)
    _provisioner(language).upgrade(project_uid, package)
    return await _mark_managed(db, env)


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
        # Python: the venv interpreter to launch. R: the private library root to
        # put on R_LIBS (the Rscript binary stays shared — renv's model).
        env.interpreter_path = (
            str(prov.venv_python(project_uid))
            if language == "python"
            else str(prov.library_path(project_uid))
        )
    else:
        env.status = "error"
    await db.commit()
    await db.refresh(env)
    return env


def needs_build(env: Environment) -> bool:
    """True when the env declares packages but its venv/library isn't materialised
    (status draft/error). An empty `system` env never needs a build."""
    return env.kind == "managed" and env.status in ("draft", "error")


async def ensure_ready(
    db: AsyncSession, project_uid: str, language: str, user_id: int
) -> Environment:
    """Make the env runnable before code executes: if it declares packages but
    isn't built yet, build it now (auto-build on first run) as a tracked job so the
    user sees it in the jobs panel. An empty/ready env returns immediately."""
    env = await resolve(db, project_uid, language)
    if not needs_build(env):
        return env
    from app.core.database import async_session
    from app.services.execution import jobs

    job = await jobs.create(
        db, project_uid, user_id, kind="build",
        label=f"Build {language_label(language)} environment",
    )

    async def body(handle) -> None:
        buffer: list[str] = []
        async with async_session() as job_db:
            await build(job_db, project_uid, language, on_log=buffer.append)
        if buffer:
            await handle.log("\n".join(buffer[-200:]))

    # Auto-build blocks this first run until the env is ready, but runs through the
    # job runner so it's visible/cancellable; then re-read the (now built) env.
    await jobs.run_now(job.id, body)
    return await resolve(db, project_uid, language)


async def _mark_managed(db: AsyncSession, env: Environment) -> Environment:
    if env.kind != "managed":
        env.kind = "managed"
    # A spec change invalidates a previously-built venv until the next build.
    env.status = "draft"
    await db.commit()
    await db.refresh(env)
    return env


def _has_disk_spec(project_uid: str, language: str) -> bool:
    """True if a committed lockfile already exists on disk for this env — the sign
    of an imported/cloned managed environment awaiting a build."""
    from app.services import project_fs

    spec_dir = project_fs.env_spec_dir(project_uid, language)
    lock = "uv.lock" if language == "python" else "renv.lock"
    return (spec_dir / lock).exists()


def _provisioner(language: str):
    if language == "python":
        from app.services.execution import uv_provisioner

        return uv_provisioner
    if language == "r":
        from app.services.execution import renv_provisioner

        return renv_provisioner
    raise ValueError(f"No managed-environment provisioner for language: {language}")
