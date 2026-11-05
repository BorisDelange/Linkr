"""patient boards say how many patients they load ahead

The board-level number of patients after the one on screen whose widgets' data
is loaded in advance (0: none). The schemas enumerate every board setting, so
without the column the API would drop the field.

Nullable with no backfill: absent reads as the default (one patient), which is
what every existing board did before the setting existed.

Revision ID: e2a8c4f6b1d3
Revises: a7c3e9f1b2d4
Create Date: 2026-11-02 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e2a8c4f6b1d3"
down_revision: Union[str, None] = "a7c3e9f1b2d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "patient_dashboards",
        sa.Column("read_ahead_patients", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("patient_dashboards", "read_ahead_patients")
