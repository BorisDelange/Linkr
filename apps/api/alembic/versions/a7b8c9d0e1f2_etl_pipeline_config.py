"""ETL pipeline per-file versioning marks

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-08-09

A pipeline holds data files beside its scripts — notably the mapping export the
vocabulary script reads, whose rows are a (possibly private) dictionary. Data
files are gitignored by default and code files versioned by default; this column
records the per-file exceptions, mirroring `projects.config`:

    {"versionedDataFiles": ["mapping/source_to_concept_map.csv"],
     "excludedFiles": ["scratch.sql"]}

Nullable with no default: a pipeline that has never been marked carries NULL and
behaves exactly as before.
"""

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision = "a7b8c9d0e1f2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("etl_pipelines", sa.Column("config", JSONB_or_JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("etl_pipelines", "config")
