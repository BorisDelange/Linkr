"""environments.resolve: lazy get-or-create of a project's per-language env."""

import pytest
from sqlalchemy import select

from app.models.environment import Environment
from app.models.project import Project
from app.services.execution import environments


@pytest.fixture(autouse=True)
async def _projects(db):
    # The environments.project_uid FK requires the project to exist.
    db.add(Project(uid="proj-1"))
    db.add(Project(uid="proj-2"))
    await db.commit()


async def test_resolve_seeds_a_system_env_on_first_access(db):
    env = await environments.resolve(db, "proj-1", "python")

    assert env.kind == "system"
    assert env.status == "ready"
    assert env.language == "python"
    # A system env carries no interpreter override → kernel falls back to the
    # shared interpreter (behaviour-preserving).
    assert env.interpreter_path is None


async def test_resolve_is_idempotent_per_project_language(db):
    first = await environments.resolve(db, "proj-1", "python")
    second = await environments.resolve(db, "proj-1", "python")

    assert first.id == second.id
    rows = (
        await db.execute(
            select(Environment).where(Environment.project_uid == "proj-1")
        )
    ).scalars().all()
    assert len(rows) == 1


async def test_resolve_separates_languages_and_projects(db):
    py = await environments.resolve(db, "proj-1", "python")
    r = await environments.resolve(db, "proj-1", "r")
    other = await environments.resolve(db, "proj-2", "python")

    assert {py.id, r.id, other.id} == {py.id, r.id, other.id}  # three distinct ids
    assert len({py.id, r.id, other.id}) == 3
