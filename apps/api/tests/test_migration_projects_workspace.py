"""Migration d3e4f5a6b7c8 moves every workspace-less project into a workspace
that grants nobody new access: a personal one of its owner, or a memberless one
(admins only) when it has no owner."""

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

API_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def alembic_at(tmp_path, monkeypatch):
    db_path = tmp_path / "m.db"
    monkeypatch.setenv("LINKR_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    from app import config as app_config

    # Same rebinding as test_migrations_match_models: env.py reads the URL from
    # app.config.settings, and the original object must come back afterwards.
    original = app_config.settings
    app_config.settings = app_config.Settings()
    cfg = Config(str(API_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_ROOT / "alembic"))
    engine = sa.create_engine(f"sqlite:///{db_path}")
    try:
        yield lambda rev: command.upgrade(cfg, rev), engine
    finally:
        engine.dispose()
        app_config.settings = original


def test_orphan_projects_move_to_a_private_workspace(alembic_at):
    upgrade, engine = alembic_at
    upgrade("c2d3e4f5a6b7")
    with engine.begin() as c:
        c.execute(sa.text("INSERT INTO users (id, username, password_hash, role, is_active, preferences) VALUES (1, 'alice', 'x', 'user', 1, '{}'), (2, 'bob', 'x', 'user', 1, '{}')"))
        c.execute(sa.text("INSERT INTO workspaces (id, name, description, origin) VALUES ('shared', '{}', '{}', 'user')"))
        c.execute(sa.text("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('shared', 2, 'owner')"))
        c.execute(sa.text(
            "INSERT INTO projects (uid, workspace_id, owner_id, name, description, short_description, config) VALUES "
            "('a1', NULL, 1, '{}', '{}', '{}', '{}'), ('a2', NULL, 1, '{}', '{}', '{}', '{}'), "
            "('none', NULL, NULL, '{}', '{}', '{}', '{}'), ('kept', 'shared', 2, '{}', '{}', '{}', '{}')"
        ))
    upgrade("head")

    with engine.connect() as c:
        ws = dict(c.execute(sa.text("SELECT uid, workspace_id FROM projects")).all())
        members = c.execute(sa.text("SELECT workspace_id, user_id, role FROM workspace_members")).all()
        with pytest.raises(sa.exc.IntegrityError):
            c.execute(sa.text("UPDATE projects SET workspace_id = NULL WHERE uid = 'kept'"))

    assert ws["kept"] == "shared"
    assert ws["a1"] == ws["a2"] not in ("shared", None)
    assert (ws["a1"], 1, "owner") in members
    assert ws["none"] not in (ws["a1"], "shared", None)
    assert not [m for m in members if m[0] == ws["none"]]
