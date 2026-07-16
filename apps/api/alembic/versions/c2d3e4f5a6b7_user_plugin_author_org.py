"""Add author + organization provenance to user_plugins

Brings user_plugins to parity with every other workspace entity: a frozen
`organization` snapshot plus the creator-provenance trio (created_by_id /
created_by / created_by_details). Previously the only workspace entity without
them, so plugin cards showed no author and exports carried no provenance.

All columns nullable — existing plugins simply have no author/org until re-saved.

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-07-16 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.models.base  # noqa: F401

# revision identifiers, used by Alembic.
revision: str = 'c2d3e4f5a6b7'
down_revision: Union[str, None] = 'b1c2d3e4f5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('user_plugins', sa.Column('organization', sa.JSON(), nullable=True))
    op.add_column('user_plugins', sa.Column('created_by_id', sa.Integer(), nullable=True))
    op.add_column('user_plugins', sa.Column('created_by', sa.Text(), nullable=True))
    op.add_column('user_plugins', sa.Column('created_by_details', sa.JSON(), nullable=True))
    # The FK is only meaningful on Postgres; SQLite can't ALTER-add a constraint,
    # and the app never relies on plugin→user referential enforcement (created_by_id
    # is a soft link resolved by ORCID/email). Add it only where supported.
    if op.get_bind().dialect.name == 'postgresql':
        op.create_foreign_key(
            op.f('fk_user_plugins_created_by_id'),
            'user_plugins', 'users', ['created_by_id'], ['id'],
        )


def downgrade() -> None:
    if op.get_bind().dialect.name == 'postgresql':
        op.drop_constraint(op.f('fk_user_plugins_created_by_id'), 'user_plugins', type_='foreignkey')
    op.drop_column('user_plugins', 'created_by_details')
    op.drop_column('user_plugins', 'created_by')
    op.drop_column('user_plugins', 'created_by_id')
    op.drop_column('user_plugins', 'organization')
