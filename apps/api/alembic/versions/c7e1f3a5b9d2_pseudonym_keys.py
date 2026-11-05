"""pseudonym keys: the HMAC key of each pseudonymised derivation, sealed

Kept apart from the derived data so a rebuild draws the same pseudonyms and a
re-identification stays possible, never returned by the API.

Revision ID: c7e1f3a5b9d2
Revises: b4d7e2a9c6f1
Create Date: 2026-11-03 16:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c7e1f3a5b9d2"
down_revision: Union[str, None] = "b4d7e2a9c6f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pseudonym_keys",
        sa.Column("id", sa.String(length=160), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("sealed_key", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_pseudonym_keys_workspace_id", "pseudonym_keys", ["workspace_id"])


def downgrade() -> None:
    op.drop_index("ix_pseudonym_keys_workspace_id", table_name="pseudonym_keys")
    op.drop_table("pseudonym_keys")
