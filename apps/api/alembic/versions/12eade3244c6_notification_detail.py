"""notification detail

Revision ID: 12eade3244c6
Revises: a6ba313ac725
Create Date: 2026-09-23 21:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.models.base  # noqa: F401


revision: str = '12eade3244c6'
down_revision: Union[str, None] = 'a6ba313ac725'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.add_column(sa.Column('detail', sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.drop_column('detail')
