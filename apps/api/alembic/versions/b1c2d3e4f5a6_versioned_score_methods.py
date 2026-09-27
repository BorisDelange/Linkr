"""mapping projects: which similarity-score methods are versioned

A method listed here travels with the export as similarity-scores/<method>.csv.
Nullable with no backfill: nothing was versioned before, and the export omits an
absent key, so existing rows export the same bytes.

Revision ID: b1c2d3e4f5a6
Revises: a37446b84515
Create Date: 2026-09-27 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "b1c2d3e4f5a6"
down_revision: Union[str, None] = "a37446b84515"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "mapping_projects",
        sa.Column("versioned_score_methods", JSONB_or_JSON, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("mapping_projects", "versioned_score_methods")
