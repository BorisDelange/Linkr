"""Derived databases: provenance on the database, derivations on the cohort.

`data_sources.derived_from` records what a database was derived from (parent,
cohort, criteria snapshot, when, how many patients); `cohorts.derivations`
lists what a cohort was derived into, so its page can offer a rebuild. Both
nullable, no backfill: nothing was derived before.

Revision ID: f4a5b6c7d8e9
Revises: e3f4a5b6c7d8
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "f4a5b6c7d8e9"
down_revision: Union[str, None] = "e3f4a5b6c7d8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("data_sources", sa.Column("derived_from", JSONB_or_JSON, nullable=True))
    op.add_column("cohorts", sa.Column("derivations", JSONB_or_JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("cohorts", "derivations")
    op.drop_column("data_sources", "derived_from")
