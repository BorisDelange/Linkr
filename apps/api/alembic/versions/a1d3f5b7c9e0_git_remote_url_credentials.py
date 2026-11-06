"""remove the credentials stored inside git remote URLs

A token pasted in a remote URL was kept with it, returned to every reader of the
entity and copied into its exports. Writes now strip it (services/git_secret); this
cleans what was stored before. The token itself is not kept: it was never tied to a
user, and the credential store is per user. Whoever relied on it enters it again.

Revision ID: a1d3f5b7c9e0
Revises: d5f7a9b1c3e2
Create Date: 2026-11-06 10:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.services import git_secret

revision: str = "a1d3f5b7c9e0"
down_revision: Union[str, None] = "d5f7a9b1c3e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = (
    "app_settings", "data_catalogs", "data_sources", "dq_rule_sets", "etl_pipelines", "mapping_projects",
    "projects", "schema_presets", "sql_script_collections", "user_plugins", "workspaces",
)


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    for name in _TABLES:
        key = inspector.get_pk_constraint(name)["constrained_columns"][0]
        table = sa.table(name, sa.column(key), sa.column("git_remote_config", sa.JSON))
        rows = conn.execute(sa.select(table.c[key], table.c.git_remote_config)).all()
        for row_id, config in rows:
            if not isinstance(config, dict):
                continue
            clean, _token = git_secret.split_config(config)
            if clean != config:
                conn.execute(table.update().where(table.c[key] == row_id).values(git_remote_config=clean))


def downgrade() -> None:
    pass
