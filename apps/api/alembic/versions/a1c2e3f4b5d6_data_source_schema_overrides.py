"""data sources keep their mapping overrides

A database copies its preset's mapping (the base) and may change parameter
values or whole relations on top (schema mapping v2, per-database override).
The overrides are stored beside the base so a preset update can replace the
base and keep them.

Revision ID: a1c2e3f4b5d6
Revises: 83e1d5666f0f
Create Date: 2026-09-25 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1c2e3f4b5d6"
down_revision: Union[str, None] = "83e1d5666f0f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("data_sources", schema=None) as batch_op:
        batch_op.add_column(sa.Column("schema_overrides", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("data_sources", schema=None) as batch_op:
        batch_op.drop_column("schema_overrides")
