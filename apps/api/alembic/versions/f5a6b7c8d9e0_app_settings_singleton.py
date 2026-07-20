"""App settings singleton (git remote for the settings versioning scope)

Adds an app_settings table holding a single row (id='account'). For now it only
carries the git_remote_config ({url, branch}, token stripped) used by the
settings versioning scope that pushes organizations + users + roles. The token
stays per (user, host) in git_credentials — nothing secret lives here.

Revision ID: f5a6b7c8d9e0
Revises: e4f5a6b7c8d9
Create Date: 2026-07-20 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.models.base  # noqa: F401

# revision identifiers, used by Alembic.
revision: str = 'f5a6b7c8d9e0'
down_revision: Union[str, None] = 'e4f5a6b7c8d9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'app_settings',
        sa.Column('id', sa.String(length=32), primary_key=True),
        sa.Column('git_remote_config', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table('app_settings')
