"""SQL script collection per-file versioning marks

Revision ID: d1e2f3a4b5c6
Revises: c0d1e2f3a4b5
Create Date: 2026-08-27

Same column, same meaning and same shape as `etl_pipelines.config`: the per-file
exceptions to the default, keyed by the file's path inside the collection.

A collection holds only `.sql`, so in practice only the `excludedFiles` half is
used — a script is committed unless the user takes it out:

    {"excludedFiles": ["scratch.sql"]}

Nullable with no default: a collection that has never been marked carries NULL
and exports exactly as before.
"""

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision = "d1e2f3a4b5c6"
down_revision = "c0d1e2f3a4b5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sql_script_collections", sa.Column("config", JSONB_or_JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("sql_script_collections", "config")
