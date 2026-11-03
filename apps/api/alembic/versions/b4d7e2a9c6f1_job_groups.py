"""jobs carry a group, so the panel folds the many queries of one action into one row

A patient opened on a board sends one query per widget, and as many again for
each patient read ahead: the panel shows them under one row per patient.

Revision ID: b4d7e2a9c6f1
Revises: e2a8c4f6b1d3
Create Date: 2026-11-03 10:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b4d7e2a9c6f1"
down_revision: Union[str, None] = "e2a8c4f6b1d3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("jobs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("group_key", sa.String(length=128), nullable=True))
        batch_op.add_column(sa.Column("group_label", sa.String(length=255), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("jobs", schema=None) as batch_op:
        batch_op.drop_column("group_label")
        batch_op.drop_column("group_key")
