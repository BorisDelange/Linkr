"""git sync anchor: last synced remote commit per entity/branch

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-07-13

Shared table recording the last remote OID an entity was in sync with, keyed by
(scope, entity_id, branch). The anchor lets the versioning UI tell "behind" from
"diverged" and underpins the coming pull (3-way merge). One table for every
versionable scope, so generalising the pull needs no per-entity column.
"""
from alembic import op
import sqlalchemy as sa

revision = "f2a3b4c5d6e7"
down_revision = "e1f2a3b4c5d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "git_sync_state",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("scope", sa.String(length=40), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=False),
        sa.Column("branch", sa.String(length=255), nullable=False),
        sa.Column("synced_oid", sa.String(length=40), nullable=False),
        sa.Column("checked_at", sa.String(length=40), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("scope", "entity_id", "branch", name="uq_git_sync_state_key"),
    )


def downgrade() -> None:
    op.drop_table("git_sync_state")
