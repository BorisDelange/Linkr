"""Manual-collection setup on a patient dashboard.

Which dataset receives what a collector types, the columns that identify the
patient, and the variables to collect. Board-level rather than project-level, so two
boards of the same project can collect into different datasets.

Nullable with no backfill: a board that has never been set up for collection has no
configuration, which is a different thing from an empty one.

Revision ID: d2e3f4a5b6c7
Revises: c1d2e3f4a5b6
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "d2e3f4a5b6c7"
down_revision: Union[str, None] = "c1d2e3f4a5b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "patient_dashboards",
        sa.Column("collection", JSONB_or_JSON, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("patient_dashboards", "collection")
