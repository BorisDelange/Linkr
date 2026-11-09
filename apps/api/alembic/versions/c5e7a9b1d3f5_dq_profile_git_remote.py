"""dq_profiles.git_remote_config: a quality profile is versioned in its own git repo

Revision ID: c5e7a9b1d3f5
Revises: b3d5f7a9c1e3
Create Date: 2026-11-09 15:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op
from app.models.base import PortableJSON

revision: str = "c5e7a9b1d3f5"
down_revision: Union[str, None] = "b3d5f7a9c1e3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("dq_profiles", schema=None) as batch_op:
        batch_op.add_column(sa.Column("git_remote_config", PortableJSON, nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("dq_profiles", schema=None) as batch_op:
        batch_op.drop_column("git_remote_config")
