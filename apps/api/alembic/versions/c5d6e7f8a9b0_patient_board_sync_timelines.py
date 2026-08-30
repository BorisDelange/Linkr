"""patient boards can sync every timeline across their tabs

The board-level switch behind cross-tab timeline sync. Without the column the
API silently dropped the field — the schemas enumerate every board setting, so
an unknown one never reaches the row — and the toggle came back off on reload.

Nullable with no backfill: absent reads as off, which is what every existing
board did before the setting existed.

Revision ID: c5d6e7f8a9b0
Revises: b4c5d6e7f8a9
Create Date: 2026-08-30 14:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c5d6e7f8a9b0"
down_revision: Union[str, None] = "b4c5d6e7f8a9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "patient_dashboards",
        sa.Column("sync_timelines_across_tabs", sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("patient_dashboards", "sync_timelines_across_tabs")
