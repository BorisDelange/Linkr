"""wiki pages gain lineage_id and parent_lineage_id

A wiki page was the one versioned element identified in its repo by a local id:
`wiki/_tree.json` carried each page's `id`/`parentId`, so every instance that
re-minted them rewrote the tree on its next push. The tree now names a page by
its entityId and carries the lineage pair every other entity has.

lineage_id is left NULL rather than backfilled, as for user plugins: a lineage is
minted when a page is created, and inventing one here would give each instance
holding the same pages a different identity for them.

Revision ID: b8d4f6a2c0e7
Revises: a7c3e5f1b9d2
Create Date: 2026-11-04 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b8d4f6a2c0e7"
down_revision: Union[str, None] = "a7c3e5f1b9d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("wiki_pages", sa.Column("lineage_id", sa.String(36), nullable=True))
    op.add_column("wiki_pages", sa.Column("parent_lineage_id", sa.String(36), nullable=True))


def downgrade() -> None:
    op.drop_column("wiki_pages", "parent_lineage_id")
    op.drop_column("wiki_pages", "lineage_id")
