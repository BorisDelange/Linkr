"""Migration 5e6f7a8b9c0d renames the databases whose alias another of their
workspace already used — compared as DuckDB mounts them — then makes the alias
unique per workspace."""

import pytest
import sqlalchemy as sa

from tests.test_migration_projects_workspace import alembic_at  # noqa: F401  -- fixture


def test_duplicates_are_renamed_oldest_first_then_refused(alembic_at):  # noqa: F811
    upgrade, engine = alembic_at
    upgrade("e4f5a6b7c8d9")
    with engine.begin() as c:
        c.execute(sa.text("INSERT INTO workspaces (id, name, description, origin) VALUES ('a', '{}', '{}', 'user'), ('b', '{}', '{}', 'user')"))
        for id_, ws, alias, at in [
            ("1", "a", "mimic", "2026-01-01"),
            ("2", "a", "MIMIC", "2026-01-02"),
            ("3", "a", "mimic", "2026-01-03"),
            ("4", "a", "mimic_2", "2026-01-04"),
            ("5", "b", "mimic", "2026-01-05"),
            ("6", "a", "My-DB", "2026-01-06"),
            ("7", "a", "my_db", "2026-01-07"),
        ]:
            c.execute(sa.text(
                "INSERT INTO data_sources (id, workspace_id, alias, name, source_type, connection_config, status, created_at, updated_at) "
                "VALUES (:i, :w, :a, '{}', 'database', '{}', 'ok', :t, :t)"
            ), {"i": id_, "w": ws, "a": alias, "t": at})
    upgrade("5e6f7a8b9c0d")

    with engine.connect() as c:
        aliases = dict(c.execute(sa.text("SELECT id, alias FROM data_sources")).all())
        with pytest.raises(sa.exc.IntegrityError):
            c.execute(sa.text("UPDATE data_sources SET alias = 'mimic' WHERE id = '4'"))

    assert aliases == {
        "1": "mimic", "2": "MIMIC_3", "3": "mimic_4", "4": "mimic_2",
        "5": "mimic", "6": "My-DB", "7": "my_db_2",
    }


def test_alias_key_is_backfilled_then_unique(alembic_at):  # noqa: F811
    upgrade, engine = alembic_at
    upgrade("6a7b8c9d0e1f")
    with engine.begin() as c:
        c.execute(sa.text("INSERT INTO workspaces (id, name, description, origin) VALUES ('a', '{}', '{}', 'user')"))
        c.execute(sa.text(
            "INSERT INTO data_sources (id, workspace_id, alias, name, source_type, connection_config, status, created_at, updated_at) "
            "VALUES ('1', 'a', 'My-DB', '{}', 'database', '{}', 'ok', '2026-01-01', '2026-01-01')"
        ))
    upgrade("head")

    with engine.connect() as c:
        assert c.execute(sa.text("SELECT alias_key FROM data_sources WHERE id = '1'")).scalar() == "my_db"
        with pytest.raises(sa.exc.IntegrityError):
            c.execute(sa.text(
                "INSERT INTO data_sources (id, workspace_id, alias, alias_key, name, source_type, connection_config, status, created_at, updated_at) "
                "VALUES ('2', 'a', 'my_db', 'my_db', '{}', 'database', '{}', 'ok', '2026-01-02', '2026-01-02')"
            ))


def test_a_collision_created_after_the_first_renaming_does_not_block_the_upgrade(alembic_at):  # noqa: F811
    upgrade, engine = alembic_at
    upgrade("6a7b8c9d0e1f")
    with engine.begin() as c:
        c.execute(sa.text("INSERT INTO workspaces (id, name, description, origin) VALUES ('a', '{}', '{}', 'user')"))
        for id_, alias, at in [("1", "My-DB", "2026-01-01"), ("2", "my_db", "2026-01-02")]:
            c.execute(sa.text(
                "INSERT INTO data_sources (id, workspace_id, alias, name, source_type, connection_config, status, created_at, updated_at) "
                "VALUES (:i, 'a', :a, '{}', 'database', '{}', 'ok', :t, :t)"
            ), {"i": id_, "a": alias, "t": at})
    upgrade("head")

    with engine.connect() as c:
        rows = dict(c.execute(sa.text("SELECT alias, alias_key FROM data_sources")).all())
    assert rows == {"My-DB": "my_db", "my_db_2": "my_db_2"}
