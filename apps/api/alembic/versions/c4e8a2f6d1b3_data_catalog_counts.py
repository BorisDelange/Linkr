"""data catalogs choose what their cells count beside patients

`counts` ({visits, unitStays}) says whether a catalog also counts hospital
stays and unit stays; NULL keeps the former behaviour (stays only).

Revision ID: c4e8a2f6d1b3
Revises: b7c1d9e3f5a2
Create Date: 2026-09-27 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "c4e8a2f6d1b3"
down_revision: Union[str, None] = "b7c1d9e3f5a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("data_catalogs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("counts", JSONB_or_JSON, nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("data_catalogs", schema=None) as batch_op:
        batch_op.drop_column("counts")
