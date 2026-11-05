"""schema_presets.preset_id is optional, as the model declares it

The retired key (e6f7a8b9c0d1 moved the primary key to `id`) kept the NOT NULL
it had as a primary key: a preset created without one was refused by a database
built by the migrations, while the model has declared it optional since.

Revision ID: e3a5c7e9b1d4
Revises: d1f3a5c7e9b2
Create Date: 2026-11-03 18:30:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e3a5c7e9b1d4"
down_revision: Union[str, None] = "d1f3a5c7e9b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("schema_presets", schema=None) as batch_op:
        batch_op.alter_column("preset_id", existing_type=sa.String(length=36), nullable=True)


def downgrade() -> None:
    # A preset with no preset_id cannot be made to hold one: nothing to undo.
    pass
