import asyncio
import fcntl
import os
import subprocess
import sys
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, make_url, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.models  # noqa: F401  -- populate Base.metadata
from app.config import settings
from app.core import audit, crypto
from app.core.database import get_db
from app.core.permissions import seed_default_roles
from app.core.security import pwd_context
from app.main import app
from app.models.base import Base
from app.services import blob_store, upload_ledger

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
def _own_app_ports(monkeypatch):
    # Each xdist worker is its own API process with its own web-app manager: on
    # one shared port range, two workers can both see a port free and race to
    # bind it ("Address already in use").
    worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
    slot = int(worker.removeprefix("gw") or 0) % 10
    lo = 8700 + slot * 10
    monkeypatch.setattr(settings, "app_port_range", f"{lo}-{lo + 9}")


_SHARED_DUCKDB_EXTENSIONS = Path(__file__).resolve().parents[3] / ".cache" / "duckdb-extensions"


@pytest.fixture(autouse=True)
def _a_stored_blob_counts_as_the_callers(request, monkeypatch):
    """Most tests put a file straight in the blob store, then attach it by its hash:
    what they test comes after. test_blob_ownership.py tests that step."""
    if not request.node.get_closest_marker("blob_ownership"):
        monkeypatch.setattr(upload_ledger, "holds", lambda _user_id, sha: blob_store.exists(sha))


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    """Point blob/upload storage at a temp dir so tests never touch ~/.linkr."""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    # data_path is a cached_property; drop any cached value so it re-resolves.
    settings.__dict__.pop("data_path", None)
    # A fresh data folder per test would download every DuckDB extension again, and a
    # test would then fail with the network: one folder, filled once, for all of them.
    _SHARED_DUCKDB_EXTENSIONS.mkdir(parents=True, exist_ok=True)
    (tmp_path / "_duckdb_ext").symlink_to(_SHARED_DUCKDB_EXTENSIONS, target_is_directory=True)
    # The free space of the machine running the tests is not what they test.
    monkeypatch.setattr(settings, "upload_free_space_reserve_mb", 0)
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


# LINKR_TEST_APP_DATABASE_URL (postgresql+asyncpg://…/<name>) runs the suite on
# Postgres, as a deployment may. The schema is the migrations' — what a Postgres
# install runs (`alembic upgrade head`), JSON columns and all — built once into
# a template database, which each test copies afresh.
_PG_URL = os.environ.get("LINKR_TEST_APP_DATABASE_URL")
_pg_template_ready = False


def _check_disposable_pg_url(raw: str, app_database_url: str | None) -> None:
    """Every test drops and recreates the database the URL names: refuse one
    that does not say it is for tests, or that is the app's own."""
    url = make_url(raw)
    name = url.database or ""
    if "test" not in name.lower():
        raise RuntimeError(
            f"LINKR_TEST_APP_DATABASE_URL names the database {name!r}, which the tests drop and recreate: "
            "give it a name containing 'test' (e.g. linkr_test)"
        )
    app_url = make_url(app_database_url) if app_database_url else None
    if app_url is not None and app_url.get_backend_name() == "postgresql" and app_url.database == name and app_url.host == url.host:
        raise RuntimeError(
            f"LINKR_TEST_APP_DATABASE_URL names {name!r}, the database LINKR_DATABASE_URL uses: the tests "
            "would drop it — point them at another one"
        )


async def _fresh_pg_database() -> str:
    global _pg_template_ready
    _check_disposable_pg_url(_PG_URL, settings.database_url)
    url = make_url(_PG_URL)
    # One database (and template) per xdist worker, or they drop each other's.
    worker = os.environ.get("PYTEST_XDIST_WORKER")
    if worker:
        url = url.set(database=f"{url.database}_{worker}")
    template = f"{url.database}_template"
    admin = create_async_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        async with admin.connect() as conn:
            if not _pg_template_ready:
                await conn.execute(text(f'DROP DATABASE IF EXISTS "{template}" WITH (FORCE)'))
                await conn.execute(text(f'CREATE DATABASE "{template}"'))
                migrated = subprocess.run(
                    [sys.executable, "-m", "alembic", "upgrade", "head"],
                    cwd=Path(__file__).resolve().parents[1],
                    env={**os.environ, "LINKR_DATABASE_URL": url.set(database=template).render_as_string(hide_password=False)},
                    capture_output=True, text=True,
                )
                assert migrated.returncode == 0, migrated.stderr[-4000:]
                _pg_template_ready = True
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{url.database}" WITH (FORCE)'))
            await conn.execute(text(f'CREATE DATABASE "{url.database}" TEMPLATE "{template}"'))
    finally:
        await admin.dispose()
    return url.render_as_string(hide_password=False)


@pytest_asyncio.fixture
async def engine(tmp_path):
    # A file and a real connection pool, as in production: each session its own
    # connection and transaction. One connection shared by every session (the
    # old in-memory StaticPool) let a request's closing rollback undo a
    # background job's writes, and a job cancelled mid-query invalidated the
    # connection, reopening the in-memory database empty under the next request.
    # WAL lets the tests' reads run beside a job's write; `timeout` is how long a
    # writer waits for another's transaction to end.
    if _PG_URL:
        eng = create_async_engine(await _fresh_pg_database())
    else:
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


def _route_sessions_to(maker, monkeypatch) -> None:
    """Point every `async_session` imported outside a request at the test database."""
    # WebSocket handlers (ws_auth, execution terminal) open a session manually via
    # `async_session` instead of the get_db dependency, so overriding get_db
    # doesn't reach them. Point their imported reference at the test maker too, or
    # they'd hit the real ~/.linkr database and see a different (or empty) dataset.
    import app.core.ws_auth as ws_auth
    import app.api.v1.routes.execution as execution_route
    import app.services.execution.jobs as jobs_svc
    import app.services.execution.run_jobs as run_jobs_svc

    monkeypatch.setattr(ws_auth, "async_session", maker)
    monkeypatch.setattr(execution_route, "async_session", maker)
    import app.api.v1.routes.apps as apps_route

    monkeypatch.setattr(apps_route, "async_session", maker)
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


@pytest_asyncio.fixture
async def db(engine, monkeypatch) -> AsyncSession:
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    # A service the test calls may run a job, which opens its own session.
    _route_sessions_to(maker, monkeypatch)
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
    _route_sessions_to(maker, monkeypatch)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()
