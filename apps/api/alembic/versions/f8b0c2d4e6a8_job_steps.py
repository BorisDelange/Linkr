"""jobs carry their steps, for the panel to show under a job of several

Revision ID: f8b0c2d4e6a8
Revises: e6a8c0e2b4d6
Create Date: 2026-11-09 17:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op
from app.models.base import PortableJSON

revision: str = "f8b0c2d4e6a8"
down_revision: Union[str, None] = "e6a8c0e2b4d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("jobs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("steps", PortableJSON, nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("jobs", schema=None) as batch_op:
        batch_op.drop_column("steps")
