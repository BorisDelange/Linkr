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

    assert len({py.id, r.id, other.id}) == 3  # three distinct ids


async def test_resolve_seeds_managed_draft_when_lockfile_on_disk(db):
    # Simulate a cloned/imported project: its committed lockfile is already on
    # disk before any env row exists.
    from app.services import project_fs

    spec = project_fs.env_spec_dir("proj-1", "python")
    (spec / "uv.lock").write_text("version = 1\n")

    env = await environments.resolve(db, "proj-1", "python")
    assert env.kind == "managed"
    assert env.status == "draft"  # awaits a manual build


async def test_build_failure_marks_env_error_and_raises(db, monkeypatch):
    """A failed build persists env.status='error' AND raises, so the calling job is
    marked 'error' instead of a misleading 'done'."""
    from app.services.execution.uv_provisioner import BuildResult, ProvisionError

    class _FailingProv:
        async def build(self, project_uid, on_log=None):
            if on_log:
                on_log("boom")
            return BuildResult(ok=False, log="boom")

    monkeypatch.setattr(environments, "_provisioner", lambda language: _FailingProv())

    with pytest.raises(ProvisionError):
        await environments.build(db, "proj-1", "python")

    env = await environments.resolve(db, "proj-1", "python")
    assert env.status == "error"
