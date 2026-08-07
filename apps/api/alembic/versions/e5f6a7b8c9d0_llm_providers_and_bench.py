"""LLM providers and bench reports

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-08-07

Moves the AI assistant's configuration out of the browser: an admin configures a
provider for the whole workspace and approves it per surface, and a bench run is
stored so everyone sees the evaluation rather than only the browser that ran it.

The API key is stored Fernet-encrypted (app/core/crypto.py) and is never returned
by the API.
"""

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision = "e5f6a7b8c9d0"
down_revision = "d4e5f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "llm_providers",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(36),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", JSONB_or_JSON, nullable=True),
        sa.Column("kind", sa.String(40), nullable=False, server_default="local-openai-compatible"),
        sa.Column("base_url", sa.String(500), nullable=False, server_default=""),
        sa.Column("model", sa.String(200), nullable=False, server_default=""),
        sa.Column("api_key_encrypted", sa.Text(), nullable=True),
        # Derived server-side from base_url, never taken from the client.
        sa.Column("is_local", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("surfaces", JSONB_or_JSON, nullable=True),
        sa.Column("acknowledged_by_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acknowledgement_text", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_llm_providers_workspace_id", "llm_providers", ["workspace_id"])

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


def downgrade() -> None:
    op.drop_index("ix_llm_bench_reports_model", table_name="llm_bench_reports")
    op.drop_index("ix_llm_bench_reports_workspace_id", table_name="llm_bench_reports")
    op.drop_table("llm_bench_reports")
    op.drop_index("ix_llm_providers_workspace_id", table_name="llm_providers")
    op.drop_table("llm_providers")
