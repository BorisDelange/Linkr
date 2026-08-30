"""mapping projects carry a portable pointer to their source database

`data_source_id` is a local UUID: exported, it addresses nothing on the
receiving instance, so the export reset it to '' and every re-imported
database-source project landed with no database attached. `data_source_ref`
({lineageId?, entityId?, label?}) is the portable form the export carries and
the import resolves back to a local row — the same split `schema_source`
already uses for a database's preset.

Nullable with no backfill: the pointer is stamped when the database is picked,
and a project whose database was never re-picked has nothing to point at. The
export omits the key when it is absent, so adding the column changes no
exported bytes for existing projects.

Revision ID: b4c5d6e7f8a9
Revises: a3b4c5d6e7f8
Create Date: 2026-08-30 10:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "b4c5d6e7f8a9"
down_revision: Union[str, None] = "a3b4c5d6e7f8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "mapping_projects", sa.Column("data_source_ref", JSONB_or_JSON, nullable=True)
    )


def downgrade() -> None:
    op.drop_column("mapping_projects", "data_source_ref")
