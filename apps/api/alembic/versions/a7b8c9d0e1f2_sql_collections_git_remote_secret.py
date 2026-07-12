"""sql_script_collections: add encrypted git_remote_secret

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-07-13

Lets a SQL script collection linked to a private git remote store its access
token Fernet-encrypted (never in the plaintext git_remote_config, never returned
by the API), mirroring projects/workspaces/mapping-projects.
"""
from alembic import op
import sqlalchemy as sa

revision = "a7b8c9d0e1f2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sql_script_collections", sa.Column("git_remote_secret", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("sql_script_collections", "git_remote_secret")
