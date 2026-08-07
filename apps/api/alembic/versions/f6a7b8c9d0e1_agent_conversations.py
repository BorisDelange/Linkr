"""Agent conversations

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-08-07

Chat threads with the assistant, so a user can revisit and delete past
conversations instead of losing them on reload.

A prompt can carry clinical context, hence `user_id` is NOT NULL and every route
filters on it: a conversation is private to its author. Saving is opt-out from
the assistant's settings, so an empty table is a valid state.
"""

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision = "f6a7b8c9d0e1"
down_revision = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_conversations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(36),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("project_uid", sa.String(36), nullable=True),
        sa.Column("surface", sa.String(40), nullable=False, server_default="dashboard"),
        sa.Column("entity_id", sa.String(36), nullable=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.Text(), nullable=False, server_default=""),
        sa.Column("messages", JSONB_or_JSON, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index(
        "ix_agent_conversations_workspace_id", "agent_conversations", ["workspace_id"]
    )
    op.create_index("ix_agent_conversations_user_id", "agent_conversations", ["user_id"])
    op.create_index("ix_agent_conversations_project_uid", "agent_conversations", ["project_uid"])
    op.create_index("ix_agent_conversations_entity_id", "agent_conversations", ["entity_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_conversations_entity_id", table_name="agent_conversations")
    op.drop_index("ix_agent_conversations_project_uid", table_name="agent_conversations")
    op.drop_index("ix_agent_conversations_user_id", table_name="agent_conversations")
    op.drop_index("ix_agent_conversations_workspace_id", table_name="agent_conversations")
    op.drop_table("agent_conversations")
