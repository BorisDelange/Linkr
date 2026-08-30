"""data catalogs: portable database pointer + resumable compute offset

Same fix `data_source_ref` brought to mapping projects, for the type that had
the identical bug: `data_source_id` is a local UUID, so an exported catalog
pointed at a row that does not exist on the receiving instance — and the git
clone path went further and wrote the foreign id over a correct local link.
`data_source_ref` ({lineageId?, entityId?, label?}) is the portable form the
export carries and the import resolves back to a local database.

Nullable with no backfill: the pointer is stamped when the database is picked,
and a catalog whose database was never re-picked has nothing to point at. The
export omits the key when it is absent, so adding the column changes no
exported bytes for existing catalogs.

Revision ID: e7f8a9b0c1d2
Revises: d6e7f8a9b0c1
Create Date: 2026-08-30 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "e7f8a9b0c1d2"
down_revision: Union[str, None] = "d6e7f8a9b0c1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "data_catalogs", sa.Column("data_source_ref", JSONB_or_JSON, nullable=True)
    )
    # Period rows a paused computation has written; NULL = no run in flight.
    # Nothing to backfill: before this, a computation could only run to completion.
    op.add_column(
        "data_catalogs", sa.Column("computed_periods", sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("data_catalogs", "computed_periods")
    op.drop_column("data_catalogs", "data_source_ref")
