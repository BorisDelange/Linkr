"""environments.resolve: lazy get-or-create of a project's per-language env."""

import pytest
from sqlalchemy import select

from app.models.environment import Environment
from app.models.project import Project
from app.models.workspace import Workspace
from app.services.execution import environments


@pytest.fixture(autouse=True)
async def _projects(db):
    # The environments.project_uid FK requires the project to exist.
    db.add(Workspace(id="ws1"))
    await db.flush()
    db.add(Project(uid="proj-1", workspace_id="ws1"))
    db.add(Project(uid="proj-2", workspace_id="ws1"))
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
        async def build(self, project_uid, on_log=None, options=None):
            if on_log:
                on_log("boom")
            return BuildResult(ok=False, log="boom")

    monkeypatch.setattr(environments, "_provisioner", lambda language: _FailingProv())

    with pytest.raises(ProvisionError):
        await environments.build(db, "proj-1", "python")

    env = await environments.resolve(db, "proj-1", "python")
    assert env.status == "error"


def test_needs_build_asks_the_disk_not_just_the_status(monkeypatch, tmp_path):
    """A `ready` status routinely lies: the built library is a machine-local,
    git-ignored cache, so an imported/cloned project (or a cleared cache) has a
    committed lockfile and NO library. Running then executes against an empty
    library and `library(dplyr)` fails, with no build ever triggered."""
    from app.models.environment import Environment
    from app.services.execution import environments as E

    env = Environment(project_uid="p1", language="r", kind="managed", status="ready")

    # Committed lockfile present, library NOT materialised → must build, despite 'ready'.
    monkeypatch.setattr(E, "_has_disk_spec", lambda uid, lang: True)
    monkeypatch.setattr(E, "_provisioner", lambda lang: type("P", (), {"is_built": staticmethod(lambda uid: False)}))
    assert E.needs_build(env) is True

    # Same spec, library built → no rebuild.
    monkeypatch.setattr(E, "_provisioner", lambda lang: type("P", (), {"is_built": staticmethod(lambda uid: True)}))
    assert E.needs_build(env) is False

    # A failed build is retried on the next run (network blip recovers by itself).
    env.status = "error"
    monkeypatch.setattr(E, "_provisioner", lambda lang: type("P", (), {"is_built": staticmethod(lambda uid: False)}))
    assert E.needs_build(env) is True

    # Never re-enter a build already in flight.
    env.status = "building"
    assert E.needs_build(env) is False

    # No committed spec at all → nothing to materialise.
    env.status = "ready"
    monkeypatch.setattr(E, "_has_disk_spec", lambda uid, lang: False)
    assert E.needs_build(env) is False


def test_needs_build_true_for_a_system_env_whose_spec_appeared_after_resolve(monkeypatch):
    """The env row is created ONCE. An import or `git pull` can drop renv.lock in
    AFTER it was first resolved as system/ready, which no status transition catches."""
    from app.models.environment import Environment
    from app.services.execution import environments as E

    env = Environment(project_uid="p1", language="r", kind="system", status="ready")
    monkeypatch.setattr(E, "_has_disk_spec", lambda uid, lang: True)
    monkeypatch.setattr(E, "_provisioner", lambda lang: type("P", (), {"is_built": staticmethod(lambda uid: False)}))
    assert E.needs_build(env) is True


async def test_ensure_ready_streams_build_lines_to_on_log(monkeypatch, db):
    """The IDE passes a live channel so the console shows the build progressing
    instead of sitting on "Loading R runtime" for minutes. Lines are produced by a
    provisioner running in a worker thread, so they must reach an async on_log."""
    from app.services.execution import environments as E

    from app.core.security import hash_password
    from app.models.user import User

    user = User(username="envstream", password_hash=hash_password("pw-for-tests-only"))
    db.add(user)
    await db.commit()
    await db.refresh(user)

    project_uid = "proj-1"
    seen: list[str] = []

    async def on_log(line: str) -> None:
        seen.append(line)

    async def fake_build(job_db, uid, lang, on_log=None, accepted_spec=None):
        for line in ("installing dplyr", "installing ggplot2"):
            if on_log is not None:
                on_log(line)
        env = await E.resolve(job_db, uid, lang)
        env.status = "ready"
        await job_db.commit()
        return env

    monkeypatch.setattr(E, "build", fake_build)
    calls = {"n": 0}

    def fake_needs_build(env):
        # True on the first check (trigger the build), False on the re-read after.
        calls["n"] += 1
        return calls["n"] == 1

    monkeypatch.setattr(E, "needs_build", fake_needs_build)

    await E.accept_spec(db, user.id, project_uid, "r")
    await E.ensure_ready(db, project_uid, "r", user_id=user.id, on_log=on_log)
    assert seen == ["installing dplyr", "installing ggplot2"]


async def test_a_run_does_not_start_on_an_environment_whose_build_failed(monkeypatch, db):
    from app.core.security import hash_password
    from app.models.user import User
    from app.services.execution import environments as E
    from app.services.execution.renv_provisioner import RENV_MISSING_HINT, ProvisionError

    user = User(username="envfail", password_hash=hash_password("pw-for-tests-only"))
    db.add(user)
    await db.commit()
    await db.refresh(user)

    async def failing_build(job_db, uid, lang, on_log=None, accepted_spec=None):
        raise ProvisionError(f"$ Rscript renv::restore()\nthere is no package called 'renv'\n{RENV_MISSING_HINT}")

    monkeypatch.setattr(E, "build", failing_build)
    monkeypatch.setattr(E, "needs_build", lambda env: True)
    await E.accept_spec(db, user.id, "proj-1", "r")
    with pytest.raises(E.EnvironmentBuildFailed) as raised:
        await E.ensure_ready(db, "proj-1", "r", user_id=user.id)
    assert raised.value.status_code == 422
    assert "environment could not be built" in raised.value.message
    assert "install.packages(\"renv\")" in raised.value.message


def test_a_missing_renv_is_named_with_its_remedy(monkeypatch):
    import subprocess

    from app.services.execution import renv_provisioner as R

    def fake_run(*_args, **_kwargs):
        return subprocess.CompletedProcess([], 1, "", "Error in loadNamespace(x) : there is no package called ‘renv’\n")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(R, "_spec_dir", lambda uid: __import__("pathlib").Path("."))
    with pytest.raises(R.ProvisionError, match="install.packages"):
        R._run_r("p1", "renv::restore()")


async def _user(db, name):
    from app.core.security import hash_password
    from app.models.user import User

    user = User(username=name, password_hash=hash_password("pw-for-tests-only"))
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _jobs_of(db, project_uid):
    from app.models.job import Job

    return (await db.execute(select(Job).where(Job.project_uid == project_uid))).scalars().all()


async def test_a_first_r_preparation_is_a_job_with_its_install_log(monkeypatch, db):
    """On an R that compiles packages, preparing Linkr's own R packages takes minutes
    before the first R run: the user follows it in the jobs panel."""
    from app.services.execution import kernel, renv_provisioner

    user = await _user(db, "rprep")
    ready = iter([False, True])
    monkeypatch.setattr(renv_provisioner, "shared_r_ready", lambda: next(ready))
    monkeypatch.setattr(renv_provisioner, "ensure_r_sandbox", lambda on_log=None: None)
    monkeypatch.setattr(renv_provisioner, "ensure_kernel_r_lib", lambda on_log=None: on_log("installing svglite"))
    monkeypatch.setattr(renv_provisioner, "ensure_client_r_package", lambda on_log=None: on_log("installing linkr"))
    monkeypatch.setattr(renv_provisioner, "client_r_deps_ready", lambda: True)

    await kernel.KernelManager()._prepare_r_shared("r", ("proj-1", user.id))

    [job] = await _jobs_of(db, "proj-1")
    await db.refresh(job)
    assert job.label == "Prepare R for Linkr" and job.status == "done"
    assert "installing svglite" in job.log_tail and "installing linkr" in job.log_tail


async def test_a_first_r_preparation_that_leaves_something_missing_ends_in_error(monkeypatch, db):
    from app.services.execution import kernel, renv_provisioner

    user = await _user(db, "rprepfail")
    monkeypatch.setattr(renv_provisioner, "shared_r_ready", lambda: False)
    monkeypatch.setattr(renv_provisioner, "client_r_deps_ready", lambda: True)
    for name in ("ensure_r_sandbox", "ensure_kernel_r_lib", "ensure_client_r_package"):
        monkeypatch.setattr(renv_provisioner, name, lambda on_log=None: None)

    await kernel.KernelManager()._prepare_r_shared("r", ("proj-1", user.id))

    [job] = await _jobs_of(db, "proj-1")
    await db.refresh(job)
    assert job.status == "error" and "could not be installed" in job.log_tail


async def test_r_already_prepared_adds_no_job(monkeypatch, db):
    from app.services.execution import kernel, renv_provisioner

    user = await _user(db, "rprepdone")
    monkeypatch.setattr(renv_provisioner, "shared_r_ready", lambda: True)
    monkeypatch.setattr(renv_provisioner, "client_r_deps_ready", lambda: True)
    for name in ("ensure_r_sandbox", "ensure_kernel_r_lib", "ensure_client_r_package"):
        monkeypatch.setattr(renv_provisioner, name, lambda on_log=None: None)

    await kernel.KernelManager()._prepare_r_shared("r", ("proj-1", user.id))

    assert await _jobs_of(db, "proj-1") == []


async def _settled(job_id):
    import asyncio

    from app.services.execution import jobs

    task = jobs._tasks.get(job_id)
    if task is not None:
        await asyncio.gather(task, return_exceptions=True)


async def test_the_data_readers_of_library_linkr_install_without_holding_the_run(monkeypatch, db):
    """duckdb compiles for up to half an hour on an R that builds from source: the run
    starts at once, the install goes on as a job of its own."""
    import threading

    from app.services.execution import kernel, renv_provisioner

    user = await _user(db, "rdeps")
    release = threading.Event()

    def slow_install(on_log=None):
        on_log("compiling duckdb")
        release.wait(10)

    monkeypatch.setattr(renv_provisioner, "shared_r_ready", lambda: True)
    monkeypatch.setattr(renv_provisioner, "client_r_deps_ready", lambda: False)
    for name in ("ensure_r_sandbox", "ensure_kernel_r_lib", "ensure_client_r_package"):
        monkeypatch.setattr(renv_provisioner, name, lambda on_log=None: None)
    monkeypatch.setattr(renv_provisioner, "ensure_client_r_deps", slow_install)
    monkeypatch.setattr(kernel, "_client_deps_job", None)

    await kernel.KernelManager()._prepare_r_shared("r", ("proj-1", user.id))
    [job] = await _jobs_of(db, "proj-1")
    assert job.label == "Install the R packages of library(linkr)"
    assert job.status in ("queued", "running")

    # A second session does not start a second install.
    await kernel.KernelManager()._prepare_r_shared("r", ("proj-1", user.id))
    assert len(await _jobs_of(db, "proj-1")) == 1

    release.set()
    await _settled(job.id)
    await db.refresh(job)
    assert job.status == "done" and "compiling duckdb" in job.log_tail


async def test_data_readers_that_cannot_be_installed_end_their_job_in_error(monkeypatch, db):
    from app.services.execution import kernel, renv_provisioner

    user = await _user(db, "rdepsfail")

    def failing_install(on_log=None):
        raise renv_provisioner.ProvisionError("The R packages of library(linkr) could not be installed (exit 1).")

    monkeypatch.setattr(renv_provisioner, "shared_r_ready", lambda: True)
    monkeypatch.setattr(renv_provisioner, "client_r_deps_ready", lambda: False)
    for name in ("ensure_r_sandbox", "ensure_kernel_r_lib", "ensure_client_r_package"):
        monkeypatch.setattr(renv_provisioner, name, lambda on_log=None: None)
    monkeypatch.setattr(renv_provisioner, "ensure_client_r_deps", failing_install)
    monkeypatch.setattr(kernel, "_client_deps_job", None)

    await kernel.KernelManager()._prepare_r_shared("r", ("proj-1", user.id))
    [job] = await _jobs_of(db, "proj-1")
    await _settled(job.id)
    await db.refresh(job)
    assert job.status == "error" and "could not be installed" in job.log_tail
