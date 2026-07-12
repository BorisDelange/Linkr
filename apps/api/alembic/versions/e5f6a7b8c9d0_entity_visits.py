"""entity_visits: per-user last-visited tracking

Revision ID: e5f6a7b8c9d0
Revises: 0e1743d6bfc2
Create Date: 2026-07-12

Records when a user last visited a workspace / project / mapping project, so the
"recent" lists can be ordered by the current user's own recency instead of
entity updatedAt.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "0e1743d6bfc2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "entity_visits",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("entity_type", sa.String(length=30), nullable=False),
        sa.Column("entity_id", sa.String(length=36), nullable=False),
        sa.Column("visited_at", sa.String(length=40), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_entity_visits_user_id"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_entity_visits")),
        sa.UniqueConstraint(
            "user_id", "entity_type", "entity_id", name="uq_entity_visits_user_entity"
        ),
    )
    op.create_index(
        op.f("ix_entity_visits_user_id"), "entity_visits", ["user_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_entity_visits_user_id"), table_name="entity_visits")
    op.drop_table("entity_visits")
