"""dashboards: events shared by the dashboard's time charts

A list of `{id, date, label, color}` that the SPC widgets of a dashboard mark as
vertical lines, each widget picking the ones it shows by id. Nullable: a
dashboard without events stores nothing, and exports leave the key out.

Revision ID: 8c9d0e1f2a3b
Revises: 7b8c9d0e1f2a
Create Date: 2026-10-12 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "8c9d0e1f2a3b"
down_revision: Union[str, None] = "7b8c9d0e1f2a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("dashboards") as batch:
        batch.add_column(sa.Column("events", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("dashboards") as batch:
        batch.drop_column("events")
