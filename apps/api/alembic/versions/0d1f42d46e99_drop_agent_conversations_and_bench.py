"""Drop the in-app assistant's conversations and bench reports.

The static/WASM assistant is removed (ai-agents-plan §10): agents now act through
the MCP server from external clients, which keep their own history. Its saved
threads (`agent_conversations`) and model bench runs (`llm_bench_reports`) have
no reader left. `llm_providers` stays.

Downgrade recreates both tables empty; the dropped rows are not restored.

Revision ID: 0d1f42d46e99
Revises: b6c7d8e9f0a1
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "0d1f42d46e99"
down_revision: Union[str, None] = "b6c7d8e9f0a1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_table("agent_conversations")
    op.drop_table("llm_bench_reports")


def downgrade() -> None:
    op.create_table(
        "llm_bench_reports",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(36),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("mode", sa.String(20), nullable=False, server_default="quick"),
        sa.Column("lang", sa.String(5), nullable=False, server_default="en"),
        sa.Column("surfaces", JSONB_or_JSON, nullable=True),
        sa.Column("passed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens_per_second", sa.Float(), nullable=False, server_default="0"),
        sa.Column("cases", JSONB_or_JSON, nullable=True),
        sa.Column("ran_by_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("ran_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_llm_bench_reports_workspace_id", "llm_bench_reports", ["workspace_id"])
    op.create_index("ix_llm_bench_reports_model", "llm_bench_reports", ["model"])

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
