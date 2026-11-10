"""Migration d6f8a0c2e4b6: check names and descriptions become LocalizedStrings,
a check's table_name its group_key, and a rule set's bare empty-group keys named
groups."""

import json

import sqlalchemy as sa

from tests.test_migration_projects_workspace import alembic_at  # noqa: F401  -- fixture


def test_checks_become_multilingual_and_groups_named(alembic_at):  # noqa: F811
    upgrade, engine = alembic_at
    upgrade("c5e7a9b1d3f5")
    with engine.begin() as c:
        c.execute(sa.text("INSERT INTO workspaces (id, name, description, origin) VALUES ('w', '{}', '{}', 'user')"))
        c.execute(sa.text(
            "INSERT INTO dq_rule_sets (id, workspace_id, name, description, data_source_id, status, origin, version, "
            "check_groups, created_at, updated_at) VALUES ('rs', 'w', '{}', '{}', 'db', 'draft', 'user', '0.1.0', "
            "'[\"Vitals\"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ))
        for id_, name, description, table in (("c1", "Not null", "never empty", "person"), ("c2", "Mine", "", None)):
            c.execute(sa.text(
                'INSERT INTO dq_custom_checks (id, rule_set_id, check_key, name, description, category, severity, threshold, '
                'sql, "order", origin, table_name, disabled, created_at, updated_at) VALUES (:id, \'rs\', :id, :name, :d, '
                "'conformance', 'error', 0, 'SELECT 1', 0, 'manual', :t, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            ), {"id": id_, "name": name, "d": description, "t": table})
    upgrade("d6f8a0c2e4b6")

    with engine.connect() as c:
        rows = {r[0]: r[1:] for r in c.execute(sa.text("SELECT id, name, description, group_key FROM dq_custom_checks"))}
        groups = c.execute(sa.text("SELECT check_groups FROM dq_rule_sets")).scalar()
    assert {k: (json.loads(n), json.loads(d), g) for k, (n, d, g) in rows.items()} == {
        "c1": ({"en": "Not null"}, {"en": "never empty"}, "person"),
        "c2": ({"en": "Mine"}, {}, None),
    }
    assert (json.loads(groups) if isinstance(groups, str) else groups) == [
        {"key": "Vitals", "name": {"en": "Vitals"}, "parentKey": None},
    ]
