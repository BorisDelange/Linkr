"""git_remote_secret on ETL / catalogs / DQ / schema presets / user plugins

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-07-13

Extends the encrypted git access-token column (Fernet, never in the plaintext
git_remote_config, never returned by the API) to the remaining versionable
entities, so each can link a private git remote. Mirrors the earlier per-entity
secret columns (projects/workspaces/mapping-projects/sql-script-collections).
"""
from alembic import op
import sqlalchemy as sa

revision = "b8c9d0e1f2a3"
down_revision = "a7b8c9d0e1f2"
branch_labels = None
depends_on = None

_TABLES = (
    "etl_pipelines",
    "data_catalogs",
    "dq_rule_sets",
    "schema_presets",
    "user_plugins",
)


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(table, sa.Column("git_remote_secret", sa.Text(), nullable=True))


def downgrade() -> None:
    for table in _TABLES:
        op.drop_column(table, "git_remote_secret")
