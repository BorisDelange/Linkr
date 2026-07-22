"""git_content_status table

Tracks the per-instance reconstitution status of git-linked entities' content
(pending clone / failed) so the UI can badge cards + offer a retry. See
app/models/git_content_status.py.

Revision ID: 000000000002
Revises: 000000000001
Create Date: 2026-07-22

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '000000000002'
down_revision: Union[str, None] = '000000000001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'git_content_status',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('scope', sa.String(length=40), nullable=False),
        sa.Column('entity_id', sa.String(length=64), nullable=False),
        sa.Column('workspace_id', sa.String(length=36), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_git_content_status')),
        sa.UniqueConstraint('scope', 'entity_id', name='uq_git_content_status_key'),
    )
    op.create_index(
        op.f('ix_git_content_status_workspace_id'),
        'git_content_status',
        ['workspace_id'],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_git_content_status_workspace_id'), table_name='git_content_status')
    op.drop_table('git_content_status')
