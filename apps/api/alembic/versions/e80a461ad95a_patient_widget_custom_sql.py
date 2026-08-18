"""Add custom_sql to patient dashboard widgets.

`custom_sql` was appended to the d8e9f0a1b2c3 migration after that revision had
already been applied, so databases stamped at it never got the column and every
widget read raised "no such column". Adding it here instead: an applied revision
must never be edited in place.

Guarded by an inspector check so a database created from the amended
d8e9f0a1b2c3 (which does emit the column) upgrades cleanly too.

Revision ID: e80a461ad95a
Revises: d8e9f0a1b2c3
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e80a461ad95a"
down_revision: Union[str, None] = "d8e9f0a1b2c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "patient_dashboard_widgets"
COLUMN = "custom_sql"


def _has_column() -> bool:
    inspector = sa.inspect(op.get_bind())
    return COLUMN in {col["name"] for col in inspector.get_columns(TABLE)}


def upgrade() -> None:
    if not _has_column():
        op.add_column(TABLE, sa.Column(COLUMN, sa.Text(), nullable=True))


def downgrade() -> None:
    if _has_column():
        op.drop_column(TABLE, COLUMN)
