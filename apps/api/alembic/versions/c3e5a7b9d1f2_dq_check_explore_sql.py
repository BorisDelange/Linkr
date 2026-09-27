"""DQ checks list their violating rows

A check keeps a second, optional query listing the rows it counts as
violations, opened by Investigate.

Revision ID: c3e5a7b9d1f2
Revises: b2d4f6a8c0e1
Create Date: 2026-09-27 15:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c3e5a7b9d1f2"
down_revision: Union[str, None] = "b2d4f6a8c0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("dq_custom_checks", schema=None) as batch_op:
        batch_op.add_column(sa.Column("explore_sql", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("dq_custom_checks", schema=None) as batch_op:
        batch_op.drop_column("explore_sql")
