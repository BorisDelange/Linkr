import asyncio
from logging.config import fileConfig

from sqlalchemy.ext.asyncio import create_async_engine

from alembic import context

import app.models  # noqa: F401  -- import every model so metadata is complete
from app.config import settings
from app.models.base import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _render_item(type_, obj, autogen_context):
    """Render JSON-variant columns as a plain sa.JSON in migrations.

    The JSON().with_variant(JSONB, "postgresql") type otherwise autogenerates
    `postgresql.JSONB(astext_type=Text())` with an unqualified Text reference.
    A plain sa.JSON still becomes JSONB on PostgreSQL at DDL time via the variant.
    """
    from sqlalchemy import JSON
    from sqlalchemy.dialects.postgresql import JSONB

    if type_ == "type" and isinstance(obj, (JSON, JSONB)):
        autogen_context.imports.add("import sqlalchemy as sa")
        return "sa.JSON()"
    return False


def _configure(connection):
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        # SQLite cannot ALTER columns/constraints in place; batch mode recreates
        # the table (needs the metadata naming convention to name constraints).
        render_as_batch=connection.dialect.name == "sqlite",
        compare_type=True,
        render_item=_render_item,
    )


def run_migrations_offline() -> None:
    context.configure(
        url=settings.database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=settings.database_url.startswith("sqlite"),
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_run_migrations(connection):
    _configure(connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(settings.database_url)
    async with engine.connect() as connection:
        await connection.run_sync(_do_run_migrations)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
