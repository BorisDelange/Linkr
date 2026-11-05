"""Migration c4e6a8b0d2f1 gives each workspace-less database the workspace of the
earliest project linking it; one linked by none, or whose alias that workspace
already uses, stays without one and is logged."""

import sqlalchemy as sa

from tests.test_migration_projects_workspace import alembic_at  # noqa: F401  -- fixture


def test_orphan_databases_join_the_earliest_linking_projects_workspace(alembic_at, capsys):  # noqa: F811
    upgrade, engine = alembic_at
    upgrade("291160aa8fa3")
    with engine.begin() as c:
        c.execute(sa.text(
            "INSERT INTO workspaces (id, name, description, origin) VALUES "
            "('early', '{}', '{}', 'user'), ('late', '{}', '{}', 'user')"
        ))
        for id_, ws, alias in [
            ("linked", None, "mimic"),
            ("unlinked", None, "lonely"),
            ("clash", None, "omop"),
            ("taken", "early", "omop"),
        ]:
            c.execute(sa.text(
                "INSERT INTO data_sources (id, workspace_id, alias, alias_key, name, source_type, "
                "connection_config, status, created_at, updated_at) "
                "VALUES (:id, :ws, :alias, :alias, '{}', 'database', '{}', 'connected', '2026-01-01', '2026-01-01')"
            ), {"id": id_, "ws": ws, "alias": alias})
        for uid, ws, linked, at in [
            ("p-late", "late", '["linked"]', "2026-03-01"),
            ("p-early", "early", '["linked", "clash"]', "2026-02-01"),
        ]:
            c.execute(sa.text(
                "INSERT INTO projects (uid, workspace_id, name, description, short_description, config, "
                "linked_data_source_ids, created_at, updated_at) "
                "VALUES (:uid, :ws, '{}', '{}', '{}', '{}', :linked, :at, :at)"
            ), {"uid": uid, "ws": ws, "linked": linked, "at": at})

    # env.py's fileConfig gives alembic's loggers a stderr handler of their own
    # and clears any other: the warnings are read where they are written.
    upgrade("head")
    logged = capsys.readouterr().err

    with engine.connect() as c:
        ws = dict(c.execute(sa.text("SELECT id, workspace_id FROM data_sources")).all())
    assert ws == {"linked": "early", "unlinked": None, "clash": None, "taken": "early"}
    assert "unlinked (lonely) is linked by no project" in logged
    assert "clash (omop): workspace early already has" in logged
