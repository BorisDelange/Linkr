"""mapping projects remember how far their source-concept extraction got

A database project's concepts are extracted in batches, because profiling each
one scans the clinical tables. The progress was written to the project row on
the client but had nowhere to land in server mode, so a reload — or coming
back three days later — restarted the whole dictionary.

Nullable with no backfill: only a database project that has run the extraction
has anything to store, and the export omits the key when it is absent, so this
changes no exported bytes for existing projects.

Revision ID: d6e7f8a9b0c1
Revises: c5d6e7f8a9b0
Create Date: 2026-08-30 16:40:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "d6e7f8a9b0c1"
down_revision: Union[str, None] = "c5d6e7f8a9b0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "mapping_projects", sa.Column("source_extraction", JSONB_or_JSON, nullable=True)
    )


def downgrade() -> None:
    op.drop_column("mapping_projects", "source_extraction")
