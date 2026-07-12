"""mapping_projects: add encrypted git_remote_secret

Revision ID: f6a7b8c9d0e1
Revises: 620b1821e106
Create Date: 2026-07-12

Lets a mapping project linked to a private git remote store its access token
Fernet-encrypted (never in the plaintext git_remote_config, never returned by
the API), mirroring projects/workspaces.
"""
from alembic import op
import sqlalchemy as sa

revision = "f6a7b8c9d0e1"
down_revision = "620b1821e106"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("mapping_projects", sa.Column("git_remote_secret", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("mapping_projects", "git_remote_secret")
