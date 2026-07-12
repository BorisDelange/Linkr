"""projects + workspaces: add encrypted git_remote_secret

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-07-12

Git access tokens for private remotes are stored Fernet-encrypted in a
dedicated column (never in the plaintext git_remote_config JSON, never returned
by the API), mirroring data_sources.connection_secret.
"""
from alembic import op
import sqlalchemy as sa

revision = "b2c3d4e5f6a7"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("git_remote_secret", sa.Text(), nullable=True))
    op.add_column("workspaces", sa.Column("git_remote_secret", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("workspaces", "git_remote_secret")
    op.drop_column("projects", "git_remote_secret")
