"""The migration chain must produce the same schema the models declare.

The test suite builds its schema with `Base.metadata.create_all`, so migrations
are never exercised by the other tests — a column added to a model and to an
ALREADY-APPLIED migration (rather than a new one) passes every test while every
real deployment raises "no such column" at runtime. That happened to
`patient_dashboard_widgets.custom_sql`.

This runs the real chain against a scratch database and diffs it against the
models, so the same mistake fails here instead of in production.
"""

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

import app.models  # noqa: F401  -- registers every model on the shared metadata
from app.models.base import Base

API_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def migrated_db(tmp_path_factory, monkeypatch_module) -> sa.Engine:
    """A database built by running every migration from zero."""
    db_path = tmp_path_factory.mktemp("migrations") / "migrated.db"
    # alembic/env.py resolves the URL from settings, not from the Config object,
    # so pointing it at the scratch file means setting the env var it reads.
    monkeypatch_module.setenv("LINKR_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")

    from app import config as app_config

    app_config.settings = app_config.Settings()

    cfg = Config(str(API_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_ROOT / "alembic"))
    command.upgrade(cfg, "head")

    engine = sa.create_engine(f"sqlite:///{db_path}")
    yield engine
    engine.dispose()


@pytest.fixture(scope="module")
def monkeypatch_module():
    """`monkeypatch` is function-scoped; this fixture is module-scoped."""
    mp = pytest.MonkeyPatch()
    yield mp
    mp.undo()


def test_every_model_table_exists(migrated_db: sa.Engine) -> None:
    tables = set(sa.inspect(migrated_db).get_table_names())
    missing = sorted(t for t in Base.metadata.tables if t not in tables)
    assert not missing, f"migrations never create: {missing}"


def test_every_model_column_exists(migrated_db: sa.Engine) -> None:
    inspector = sa.inspect(migrated_db)
    tables = set(inspector.get_table_names())

    problems: list[str] = []
    for name, table in sorted(Base.metadata.tables.items()):
        if name not in tables:
            continue
        actual = {col["name"] for col in inspector.get_columns(name)}
        for column in table.columns:
            if column.name not in actual:
                # Almost always: the column was appended to a migration that had
                # already run somewhere. It needs its own new revision.
                problems.append(f"{name}.{column.name}")

    assert not problems, (
        "columns declared on a model but never created by a migration: "
        f"{problems}. Add a NEW revision — editing an applied one is a no-op "
        "for any database already stamped past it."
    )


def test_single_head(migrated_db: sa.Engine) -> None:
    # Two heads make `alembic upgrade head` ambiguous and it refuses to run.
    version = sa.inspect(migrated_db)
    assert "alembic_version" in version.get_table_names()
    with migrated_db.connect() as conn:
        heads = conn.execute(sa.text("SELECT version_num FROM alembic_version")).all()
    assert len(heads) == 1, f"expected one head, found {heads}"
