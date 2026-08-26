"""projects gain entity_id, the name every other entity gives its slug

A project's readable identifier was called `project_id` while every other
entity calls the same thing `entity_id` — same role (set once, never changes,
the folder name in exports), two names. This adds the column and backfills it
from `project_id`, which IS that value.

`project_id` is kept, not dropped: published repos carry it (both projects in
linkr-public-content do), and the catalog install still reads it. The export
writes both for now, so a repo stays readable by a Linkr that predates the
rename; dropping it is a later step, once no supported version reads it.

Revision ID: b9c0d1e2f3a4
Revises: a8b9c0d1e2f3
Create Date: 2026-08-26 08:05:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b9c0d1e2f3a4"
down_revision: Union[str, None] = "a8b9c0d1e2f3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("entity_id", sa.String(255), nullable=True))
    # The slug already lives in project_id; copying rather than minting keeps the
    # folder names in existing exports and git working trees valid.
    op.execute("UPDATE projects SET entity_id = project_id WHERE project_id IS NOT NULL")


def downgrade() -> None:
    op.drop_column("projects", "entity_id")
