"""dashboards: a dataset reference holds a dataset PATH in server mode

`dashboards.default_dataset_file_id` and `dashboard_widgets.dataset_file_id` were
sized for a uuid, but in server mode a dataset's id is its path inside the
project. Moving a dataset to a path longer than 36 characters then failed on
Postgres (SQLite does not enforce the length). Widened to the size
`dataset_analyses.dataset_path` already has.

Revision ID: 6a7b8c9d0e1f
Revises: 5e6f7a8b9c0d
Create Date: 2026-10-08 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "6a7b8c9d0e1f"
down_revision: Union[str, None] = "5e6f7a8b9c0d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (("dashboards", "default_dataset_file_id"), ("dashboard_widgets", "dataset_file_id"))


def upgrade() -> None:
    for table, column in _COLUMNS:
        with op.batch_alter_table(table) as batch:
            batch.alter_column(column, existing_type=sa.String(length=36), type_=sa.String(length=1024))


def downgrade() -> None:
    # A path longer than 36 characters would not fit back: it is cut, like any
    # narrowing, rather than blocking the downgrade.
    for table, column in _COLUMNS:
        op.execute(sa.text(f"UPDATE {table} SET {column} = SUBSTR({column}, 1, 36) WHERE LENGTH({column}) > 36"))
        with op.batch_alter_table(table) as batch:
            batch.alter_column(column, existing_type=sa.String(length=1024), type_=sa.String(length=36))
