"""user_plugins: add git_remote_config

Revision ID: a1b2c3d4e5f6
Revises: 75244d51e062
Create Date: 2026-07-11

Adds the git_remote_config column so plugins support export/versioning like
other entities (SQL collections, ETL pipelines, mapping projects).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "a1b2c3d4e5f6"
down_revision = "75244d51e062"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # JSONB on Postgres, JSON elsewhere (SQLite) — mirrors JSONB_or_JSON in models.
    json_type = postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite")
    op.add_column("user_plugins", sa.Column("git_remote_config", json_type, nullable=True))


def downgrade() -> None:
    op.drop_column("user_plugins", "git_remote_config")
