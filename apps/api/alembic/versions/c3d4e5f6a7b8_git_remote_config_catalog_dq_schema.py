"""catalog / dq_rule_set / schema_preset: add git_remote_config

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-07-12

Adds git_remote_config so data catalogs, DQ rule sets and schema presets support
export/versioning like the other entities.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "c3d4e5f6a7b8"
down_revision = "b2c3d4e5f6a7"
branch_labels = None
depends_on = None

_JSON = postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite")


def upgrade() -> None:
    op.add_column("data_catalogs", sa.Column("git_remote_config", _JSON, nullable=True))
    op.add_column("dq_rule_sets", sa.Column("git_remote_config", _JSON, nullable=True))
    op.add_column("schema_presets", sa.Column("git_remote_config", _JSON, nullable=True))


def downgrade() -> None:
    op.drop_column("schema_presets", "git_remote_config")
    op.drop_column("dq_rule_sets", "git_remote_config")
    op.drop_column("data_catalogs", "git_remote_config")
