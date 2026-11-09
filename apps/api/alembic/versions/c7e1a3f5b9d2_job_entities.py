"""jobs carry the entity they are for (a database, a project), for the panel to
name and order them

Revision ID: c7e1a3f5b9d2
Revises: a1d3f5b7c9e0
Create Date: 2026-11-08 10:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "c7e1a3f5b9d2"
down_revision: Union[str, None] = "a1d3f5b7c9e0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("jobs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("entity_type", sa.String(length=32), nullable=True))
        batch_op.add_column(sa.Column("entity_id", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("entity_name", sa.String(length=255), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("jobs", schema=None) as batch_op:
        batch_op.drop_column("entity_name")
        batch_op.drop_column("entity_id")
        batch_op.drop_column("entity_type")
