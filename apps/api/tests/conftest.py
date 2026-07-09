import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  -- populate Base.metadata
from app.config import settings
from app.core.database import get_db
from app.core.permissions import seed_default_roles
from app.main import app
from app.models.base import Base


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    """Point blob/upload storage at a temp dir so tests never touch ~/.linkr."""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    # data_path is a cached_property; drop any cached value so it re-resolves.
    settings.__dict__.pop("data_path", None)
    yield
    settings.__dict__.pop("data_path", None)


@pytest_asyncio.fixture(autouse=True)
async def _shutdown_kernels():
    """Kill any persistent execution kernels a test started (they're a module-level
    singleton, so they'd otherwise leak subprocesses across tests)."""
    yield
    from app.services.execution.kernel import manager

    await manager.shutdown_all()


@pytest_asyncio.fixture
async def engine():
    # Single shared in-memory connection so the schema persists across sessions.
    eng = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(eng.sync_engine, "connect")
    def _fk_pragma(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
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

    monkeypatch.setattr(ws_auth, "async_session", maker)
    monkeypatch.setattr(execution_route, "async_session", maker)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()
