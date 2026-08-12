"""git_sync_state.reviewed_oid — split the decision cursor from the content anchor

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-08-12

``synced_oid`` used to carry two meanings at once: "we hold this commit's content"
(the 3-way merge base) and "we have processed this commit" (the push gate). That
made a *partial* pull inexpressible — taking some incoming items and deliberately
keeping your own version of the rest either buried the remainder (if the anchor
advanced) or blocked the push forever (if it did not).

``reviewed_oid`` carries the second meaning alone: every item the commit brought
got an explicit decision. ``behind`` is computed against it when set, so the push
unblocks; ``synced_oid`` keeps its strict meaning and still only advances on a
complete pull.

Nullable with no backfill: an existing row has no recorded deliberation, and
inventing one would claim decisions the user never made. ``behind`` falls back to
``synced_oid`` for those rows, so their behaviour is unchanged.
"""

import sqlalchemy as sa
from alembic import op

revision = "d0e1f2a3b4c5"
down_revision = "c9d0e1f2a3b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("git_sync_state") as batch:
        batch.add_column(sa.Column("reviewed_oid", sa.String(40), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("git_sync_state") as batch:
        batch.drop_column("reviewed_oid")
