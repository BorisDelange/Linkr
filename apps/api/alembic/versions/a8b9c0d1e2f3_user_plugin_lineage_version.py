"""user plugins gain lineage_id, parent_lineage_id and version

A published plugin had no cross-instance identity: two instances holding the
same repo could only recognise it by git URL, and a fork recorded nothing about
where it came from. Every other exportable entity carries the lineage pair, and
the export writes it — the plugin was the one kind still missing the columns.

`version` joins them for the same reason: it is the author-facing semver that
travels with an export, and the plugin export could not write one it did not
store.

lineage_id is left NULL rather than backfilled with fresh uuids. A lineage is
minted when an entity is created or first cloned, and inventing one here for
every existing row would claim a published identity these plugins never had —
the client mints it on the next save, which is where the value means something.

Revision ID: a8b9c0d1e2f3
Revises: f7a8b9c0d1e2
Create Date: 2026-08-25 23:50:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a8b9c0d1e2f3"
down_revision: Union[str, None] = "f7a8b9c0d1e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("user_plugins", sa.Column("lineage_id", sa.String(36), nullable=True))
    op.add_column(
        "user_plugins", sa.Column("parent_lineage_id", sa.String(36), nullable=True)
    )
    # server_default so existing rows read '0.1.0' rather than NULL, matching the
    # model's default and what every other versioned entity stores.
    op.add_column(
        "user_plugins",
        sa.Column("version", sa.String(20), nullable=False, server_default="0.1.0"),
    )


def downgrade() -> None:
    op.drop_column("user_plugins", "version")
    op.drop_column("user_plugins", "parent_lineage_id")
    op.drop_column("user_plugins", "lineage_id")
