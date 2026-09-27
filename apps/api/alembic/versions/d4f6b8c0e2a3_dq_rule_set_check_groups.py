"""DQ rule sets keep their empty check groups

A group is the `table_name` its checks share; one created with no check yet had
nowhere to live and vanished on reload. The rule set now lists them.

Revision ID: d4f6b8c0e2a3
Revises: c3e5a7b9d1f2
Create Date: 2026-09-27 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4f6b8c0e2a3"
down_revision: Union[str, None] = "c3e5a7b9d1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("dq_rule_sets", schema=None) as batch_op:
        batch_op.add_column(sa.Column("check_groups", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("dq_rule_sets", schema=None) as batch_op:
        batch_op.drop_column("check_groups")
