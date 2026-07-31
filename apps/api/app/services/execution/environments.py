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
