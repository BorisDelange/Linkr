"""notification undo

Revision ID: ffcd32546ab7
Revises: 12eade3244c6
Create Date: 2026-09-23 22:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'ffcd32546ab7'
down_revision: Union[str, None] = '12eade3244c6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.add_column(sa.Column('undo', sa.JSON(), nullable=True))
        batch_op.add_column(sa.Column('undone_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('notifications', schema=None) as batch_op:
        batch_op.drop_column('undone_at')
        batch_op.drop_column('undo')
