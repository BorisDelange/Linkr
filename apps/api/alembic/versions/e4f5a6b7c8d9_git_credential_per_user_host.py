"""Git credentials per (user, host)

Replaces the per-entity encrypted git token (git_remote_secret, on 9 tables)
with a per-(user, host) token in a new git_credentials table. A personal access
token is host-scoped in practice, and keying it to the user stops one user from
pushing with another user's token. No data is migrated: the old per-entity
tokens are dropped and each user re-enters their token once per host.

Revision ID: e4f5a6b7c8d9
Revises: d3e4f5a6b7c8
Create Date: 2026-07-20 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.models.base  # noqa: F401

# revision identifiers, used by Alembic.
revision: str = 'e4f5a6b7c8d9'
down_revision: Union[str, None] = 'd3e4f5a6b7c8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Tables that carried the per-entity git token.
_SECRET_TABLES = (
    'workspaces', 'projects', 'mapping_projects', 'user_plugins',
    'data_catalogs', 'schema_presets', 'sql_script_collections',
    'etl_pipelines', 'dq_rule_sets',
)


def upgrade() -> None:
    op.create_table(
        'git_credentials',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('host', sa.String(length=255), nullable=False),
        sa.Column('secret', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint('user_id', 'host', name='uq_git_credential_user_host'),
    )
    op.create_index('ix_git_credentials_user_id', 'git_credentials', ['user_id'])

    for table in _SECRET_TABLES:
        with op.batch_alter_table(table) as batch:
            batch.drop_column('git_remote_secret')


def downgrade() -> None:
    for table in _SECRET_TABLES:
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column('git_remote_secret', sa.Text(), nullable=True))

    op.drop_index('ix_git_credentials_user_id', table_name='git_credentials')
    op.drop_table('git_credentials')
