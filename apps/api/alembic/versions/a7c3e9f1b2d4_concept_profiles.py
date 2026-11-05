"""concept profiles: one exact profile per (database, dictionary, concept)

Revision ID: a7c3e9f1b2d4
Revises: d1f6b2a4c8e5
Create Date: 2026-11-02 15:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op
from app.models.base import PortableJSON

# revision identifiers, used by Alembic.
revision: str = 'a7c3e9f1b2d4'
down_revision: str | None = 'd1f6b2a4c8e5'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

def upgrade() -> None:
    op.create_table(
        'concept_profiles',
        sa.Column('data_source_id', sa.String(length=36), sa.ForeignKey('data_sources.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('dict_key', sa.String(length=200), primary_key=True),
        sa.Column('concept_id', sa.BigInteger(), primary_key=True),
        sa.Column('rows_count', sa.BigInteger(), nullable=False),
        sa.Column('patients_count', sa.BigInteger(), nullable=True),
        sa.Column('sections', sa.Text(), nullable=False),
        sa.Column('variant', PortableJSON, nullable=False),
        sa.Column('fingerprint', sa.String(length=64), nullable=False),
        sa.Column('computed_at', sa.String(length=40), nullable=False),
        sa.Column('profile', PortableJSON, nullable=False),
    )

def downgrade() -> None:
    op.drop_table('concept_profiles')
