"""Cohorts and patient boards owned by a database instead of a project.

A database's own cohorts (and its one cohort-review board) live on the database
page, outside any project. Each row now has exactly one owner: `project_uid` or
`owner_data_source_id`. The second cascades with the database, as the first does
with the project. The one-owner rule is enforced by the services, not a CHECK:
SQLite would need the whole table rebuilt to add one.

No backfill: every existing row keeps its project.

Revision ID: e3f4a5b6c7d8
Revises: d2e3f4a5b6c7
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e3f4a5b6c7d8"
down_revision: Union[str, None] = "d2e3f4a5b6c7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = ("cohorts", "patient_dashboards")


def upgrade() -> None:
    for table in _TABLES:
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.alter_column("project_uid", existing_type=sa.String(length=36), nullable=True)
            batch_op.add_column(sa.Column("owner_data_source_id", sa.String(length=36), nullable=True))
            batch_op.create_foreign_key(
                f"fk_{table}_owner_data_source_id",
                "data_sources",
                ["owner_data_source_id"],
                ["id"],
                ondelete="CASCADE",
            )
            batch_op.create_index(f"ix_{table}_owner_data_source_id", ["owner_data_source_id"])


def downgrade() -> None:
    for table in _TABLES:
        op.execute(f"DELETE FROM {table} WHERE project_uid IS NULL")
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_index(f"ix_{table}_owner_data_source_id")
            batch_op.drop_constraint(f"fk_{table}_owner_data_source_id", type_="foreignkey")
            batch_op.drop_column("owner_data_source_id")
            batch_op.alter_column("project_uid", existing_type=sa.String(length=36), nullable=False)
