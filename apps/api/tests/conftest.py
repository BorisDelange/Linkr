import asyncio
import fcntl
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.models  # noqa: F401  -- populate Base.metadata
from app.config import settings
from app.core import audit, crypto
from app.core.database import get_db
from app.core.permissions import seed_default_roles
from app.core.security import pwd_context
from app.main import app
from app.models.base import Base

# Tests register and log users in constantly, and production-cost bcrypt
# (~440 ms per hash or verify) dominated the suite's runtime. 4 is bcrypt's
# minimum, keeps the exact same code path, and every hash a test verifies was
# made by a test.
pwd_context.update(bcrypt__rounds=4)

# The R kernel's shared sandbox + infra libraries are provisioned once per
# data_dir — and _isolate_data_dir gives every test a fresh one, so each R test
# re-installed the R packages from scratch (~110 s each, ~13 min of the suite).
# Point the three provisioned directories at one per-machine cache instead:
# ensure_* are idempotent-cheap once populated, so only the first R test on a
# machine ever pays. test_renv_provisioner.py patches these helpers itself, so
# its isolation is unaffected. The cache is shared by every worktree and every
# concurrent run, so each ensure_* holds an exclusive file lock while it
# provisions: two runs installing into one library would corrupt it.
_R_TEST_CACHE = Path.home() / ".cache" / "linkr-test-r"


def _under_cache_lock(ensure):
    def locked(*args, **kwargs):
        _R_TEST_CACHE.mkdir(parents=True, exist_ok=True)
        with open(_R_TEST_CACHE / ".lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return ensure(*args, **kwargs)

    return locked


@pytest.fixture(autouse=True)
def _shared_r_cache(monkeypatch):
    from app.services import project_fs
    from app.services.execution import renv_provisioner

    for name in ("r_sandbox", "kernel_r_lib", "client_r_lib"):
        sub = _R_TEST_CACHE / name.replace("_", "-")

        def _dir(d=sub):
            d.mkdir(parents=True, exist_ok=True)
            return d

        monkeypatch.setattr(project_fs, name, _dir)

    for name in ("ensure_r_sandbox", "ensure_kernel_r_lib", "ensure_client_r_lib"):
        monkeypatch.setattr(renv_provisioner, name, _under_cache_lock(getattr(renv_provisioner, name)))


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    """Point blob/upload storage at a temp dir so tests never touch ~/.linkr."""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    # data_path is a cached_property; drop any cached value so it re-resolves.
    settings.__dict__.pop("data_path", None)
    # The encryption key lives in data_dir: each test gets its own.
    crypto.reset_keyring()
    audit.reset()
    yield
    settings.__dict__.pop("data_path", None)
    crypto.reset_keyring()
    audit.reset()


@pytest.fixture(autouse=True)
def _local_git_remotes(monkeypatch):
    """The git tests use bare repos on disk as remotes, which the app refuses
    (a local remote would clone the server's own disk). Tests of that refusal
    set the flag back."""
    from app.services import git_service

    monkeypatch.setattr(git_service, "_LOCAL_REMOTES_ALLOWED", True)


@pytest_asyncio.fixture(autouse=True)
async def _shutdown_kernels():
    """Kill any persistent execution kernels a test started (they're a module-level
    singleton, so they'd otherwise leak subprocesses across tests)."""
    yield
    from app.services.execution.kernel import manager

    await manager.shutdown_all()


@pytest.fixture(autouse=True)
def _fresh_job_lanes(monkeypatch):
    """A lane's semaphore binds to the event loop it first waited in, and each
    test has its own loop."""
    from app.services.execution import jobs

    monkeypatch.setattr(jobs, "_semaphores", {})


async def _stop_background_jobs() -> None:
    """Cancel the jobs a test left running, and wait for their last status write,
    before the test's database goes away under them."""
    from app.services.execution import jobs

    pending = [t for t in jobs._tasks.values() if not t.done()]
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    await asyncio.gather(*jobs._status_writes, return_exceptions=True)
    jobs._tasks.clear()


@pytest_asyncio.fixture
async def engine(tmp_path):
    # A file and a real connection pool, as in production: each session its own
    # connection and transaction. One connection shared by every session (the
    # old in-memory StaticPool) let a request's closing rollback undo a
    # background job's writes, and a job cancelled mid-query invalidated the
    # connection, reopening the in-memory database empty under the next request.
    # WAL lets the tests' reads run beside a job's write; `timeout` is how long a
    # writer waits for another's transaction to end.
    eng = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'test.db'}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )

    @event.listens_for(eng.sync_engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA journal_mode=WAL")
        cur.close()

    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await _stop_background_jobs()
    await eng.dispose()


@pytest_asyncio.fixture
async def db(engine) -> AsyncSession:
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as session:
        yield session


@pytest_asyncio.fixture
async def seed_roles(engine):
    """Seed the default system roles (the lifespan does this in production)."""
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as session:
        await seed_default_roles(session)


@pytest_asyncio.fixture
async def client(engine, seed_roles, monkeypatch):
    # seed_roles: production seeds the default system roles at startup, and
    # permission checks (has_project_permission / require_global_permission)
    # resolve a role name to its Role row — so the rows must exist here too.
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _override_get_db():
        async with maker() as session:
            yield session

    app.dependency_overrides[get_db] = _override_get_db
    # WebSocket handlers (ws_auth, execution terminal) open a session manually via
    # `async_session` instead of the get_db dependency, so the override above
    # doesn't reach them. Point their imported reference at the test maker too, or
    # they'd hit the real ~/.linkr database and see a different (or empty) dataset.
    import app.core.ws_auth as ws_auth
    import app.api.v1.routes.execution as execution_route
    import app.services.execution.jobs as jobs_svc
    import app.services.execution.run_jobs as run_jobs_svc

    monkeypatch.setattr(ws_auth, "async_session", maker)
    monkeypatch.setattr(execution_route, "async_session", maker)
    # The vocabulary import writes the library's inventory from its own session.
    import app.api.v1.routes.vocabulary_library as vocabulary_library_route

    monkeypatch.setattr(vocabulary_library_route, "async_session", maker)
    # Job bodies (env build, package ops, run-as-job) open their own session via
    # `async_session` — point it at the test maker so they see the seeded project.
    monkeypatch.setattr(jobs_svc, "async_session", maker)
    # A deferred request that outlives its wait records itself as a job.
    import app.core.deferred as deferred_core

    monkeypatch.setattr(deferred_core, "async_session", maker)
    monkeypatch.setattr(run_jobs_svc, "async_session", maker)
    # Suggestion-engine jobs read the library inventory and write the scores file.
    import app.services.suggestions.tasks as suggestion_tasks

    monkeypatch.setattr(suggestion_tasks, "async_session", maker)
    monkeypatch.setattr("app.core.database.async_session", maker)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()
