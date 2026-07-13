"""mapping projects: author provenance

Revision ID: 9f3ac1b7e2d8
Revises: f2a3b4c5d6e7
Create Date: 2026-07-13

Brings mapping projects in line with the other authored entities: adds
created_by_id (stable identity, re-resolved by ORCID/email on import) plus
created_by / created_by_details (display snapshot for cross-instance imports).
The organization snapshot column was added earlier in e1f2a3b4c5d6.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "9f3ac1b7e2d8"
down_revision = "f2a3b4c5d6e7"
branch_labels = None
depends_on = None

_JSON = postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite")


def upgrade() -> None:
    op.add_column("mapping_projects", sa.Column("created_by_id", sa.Integer(), nullable=True))
    op.add_column("mapping_projects", sa.Column("created_by", sa.Text(), nullable=True))
    op.add_column("mapping_projects", sa.Column("created_by_details", _JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("mapping_projects", "created_by_details")
    op.drop_column("mapping_projects", "created_by")
    op.drop_column("mapping_projects", "created_by_id")
