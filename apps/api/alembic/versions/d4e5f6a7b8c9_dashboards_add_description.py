"""dashboards: add description

Revision ID: d4e5f6a7b8c9
Revises: e9e7ec8fd6eb
Create Date: 2026-07-12

Adds a localized description to dashboards, edited alongside the name in the
dashboard edit dialog.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "d4e5f6a7b8c9"
down_revision = "e9e7ec8fd6eb"
branch_labels = None
depends_on = None

_JSON = postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite")


def upgrade() -> None:
    op.add_column("dashboards", sa.Column("description", _JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("dashboards", "description")
