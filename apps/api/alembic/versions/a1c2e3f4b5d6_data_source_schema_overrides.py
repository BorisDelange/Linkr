"""data sources keep their mapping overrides

A database copies its preset's mapping (the base) and may replace whole
relations on top (schema mapping v2, per-database override).
The overrides are stored beside the base so a preset update can replace the
base and keep them.

Revision ID: a1c2e3f4b5d6
Revises: c4d5e6f7a8b9
Create Date: 2026-09-25 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "a1c2e3f4b5d6"
down_revision: Union[str, None] = "c4d5e6f7a8b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("data_sources", schema=None) as batch_op:
        batch_op.add_column(sa.Column("schema_overrides", JSONB_or_JSON, nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("data_sources", schema=None) as batch_op:
        batch_op.drop_column("schema_overrides")
