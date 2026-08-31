"""per-entity database for patient boards and cohorts

A project can link several databases, but patient boards and cohorts had no way
to say which one they read: the choice was a single "active" database held in
the browser's localStorage, shared by every board and cohort of the project and
never persisted server-side. Two users on the same project could therefore see
different data for the same board.

Each board and cohort now carries its own `data_source_id`, plus the portable
`data_source_ref` ({lineageId?, entityId?, label?}) that the export carries and
the import resolves back to a local row — the same pair `dq_rule_sets` uses.

Nullable with no backfill: the id is stamped when the database is picked, and
the old active choice lived only in a browser, so there is nothing on the server
to migrate from. A row with no id falls back to the project's first usable
linked database, which is exactly what it resolved to before.

Revision ID: b0c1d2e3f4a5
Revises: a9b0c1d2e3f4
Create Date: 2026-08-31 16:05:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "b0c1d2e3f4a5"
down_revision: Union[str, None] = "a9b0c1d2e3f4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLES = ["patient_dashboards", "cohorts"]


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(table, sa.Column("data_source_id", sa.String(36), nullable=True))
        op.add_column(table, sa.Column("data_source_ref", JSONB_or_JSON, nullable=True))


def downgrade() -> None:
    for table in reversed(_TABLES):
        op.drop_column(table, "data_source_ref")
        op.drop_column(table, "data_source_id")
