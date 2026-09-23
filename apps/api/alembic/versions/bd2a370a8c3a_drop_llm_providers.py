"""Drop the workspace LLM providers.

Their only caller was the in-app assistant, now removed: agents act through the
MCP server from external clients (LibreChat, Claude Code), which hold their own
model configuration.

Downgrade recreates the table empty; the dropped rows are not restored.

Revision ID: bd2a370a8c3a
Revises: 34f8f2a646cb
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "bd2a370a8c3a"
down_revision: Union[str, None] = "34f8f2a646cb"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index("ix_llm_providers_workspace_id", table_name="llm_providers")
    op.drop_table("llm_providers")


def downgrade() -> None:
    op.create_table(
        "llm_providers",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("workspace_id", sa.String(36), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.JSON(), nullable=True),
        sa.Column("kind", sa.String(40), nullable=False, server_default="local-openai-compatible"),
        sa.Column("base_url", sa.String(500), nullable=False, server_default=""),
        sa.Column("model", sa.String(200), nullable=False, server_default=""),
        sa.Column("api_key_encrypted", sa.Text(), nullable=True),
        sa.Column("is_local", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("surfaces", sa.JSON(), nullable=True),
        sa.Column("acknowledged_by_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acknowledgement_text", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_llm_providers_workspace_id", "llm_providers", ["workspace_id"])
