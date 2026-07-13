"""projects: author provenance

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-07-13

Adds creator provenance to projects: created_by_id (stable identity, name
resolved live from the user directory) plus created_by / created_by_details
(display snapshot kept for cross-instance imports).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "c9d0e1f2a3b4"
down_revision = "b8c9d0e1f2a3"
branch_labels = None
depends_on = None

_JSON = postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite")


def upgrade() -> None:
    op.add_column("projects", sa.Column("created_by_id", sa.Integer(), nullable=True))
    op.add_column("projects", sa.Column("created_by", sa.Text(), nullable=True))
    op.add_column("projects", sa.Column("created_by_details", _JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "created_by_details")
    op.drop_column("projects", "created_by")
    op.drop_column("projects", "created_by_id")
