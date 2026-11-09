"""Migration a1c3e5f7b9d1 gives every stored DQ check the key its export gave it."""

import sqlalchemy as sa

from tests.test_migration_projects_workspace import alembic_at  # noqa: F401  -- fixture


def test_existing_checks_get_the_key_an_export_derived(alembic_at):  # noqa: F811
    upgrade, engine = alembic_at
    upgrade("f8b0c2d4e6a8")
    with engine.begin() as c:
        c.execute(sa.text("INSERT INTO workspaces (id, name, description, origin) VALUES ('w', '{}', '{}', 'user')"))
        for rs in ("rs1", "rs2"):
            c.execute(sa.text(
                "INSERT INTO dq_rule_sets (id, workspace_id, name, description, data_source_id, status, origin, version, "
                "created_at, updated_at) VALUES (:id, 'w', '{}', '{}', 'db', 'draft', 'user', '0.1.0', "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            ), {"id": rs})
        rows = [
            ("c2", "rs1", "Same name", None, 1),
            ("c1", "rs1", "Not null", "ddl.not_null:person.id", 0),
            ("c3", "rs1", "Same name", None, 2),
            ("c4", "rs2", "Same name", None, 0),
        ]
        for id_, rs, name, tpl, order in rows:
            c.execute(sa.text(
                'INSERT INTO dq_custom_checks (id, rule_set_id, name, description, category, severity, threshold, '
                'sql, "order", origin, template_key, disabled, created_at, updated_at) VALUES (:id, :rs, :name, \'\', '
                "'conformance', 'error', 0, 'SELECT 1', :order, 'manual', :tpl, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            ), {"id": id_, "rs": rs, "name": name, "tpl": tpl, "order": order})
    upgrade("a1c3e5f7b9d1")

    with engine.connect() as c:
        keys = dict(c.execute(sa.text("SELECT id, check_key FROM dq_custom_checks")).all())
    assert keys == {"c1": "ddl.not_null:person.id", "c2": "same-name", "c3": "same-name#2", "c4": "same-name"}
