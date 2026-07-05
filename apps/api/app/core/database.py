from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.models.base import Base

engine = create_async_engine(settings.resolved_database_url, echo=settings.debug)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

# SQLite ignores foreign keys (and ON DELETE CASCADE) unless enabled per-connection.
if settings.resolved_database_url.startswith("sqlite"):

    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_fk_pragma(dbapi_conn, _connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


async def get_db() -> AsyncSession:
    """Dependency that provides a database session."""
    async with async_session() as session:
        yield session


async def create_all() -> None:
    """Create all tables. Used by tests; production uses Alembic migrations."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


__all__ = ["Base", "engine", "async_session", "get_db", "create_all"]
