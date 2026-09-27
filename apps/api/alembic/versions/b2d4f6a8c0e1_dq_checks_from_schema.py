"""DQ checks generated from a schema, Kahn categories

Every check of a rule set is now stored, including the ones generated from its
schema's DDL and mapping; a rule set points at the schema preset it came from.

Revision ID: b2d4f6a8c0e1
Revises: a1c2e3f4b5d6
Create Date: 2026-09-26 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "b2d4f6a8c0e1"
down_revision: Union[str, None] = "a1c2e3f4b5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("dq_rule_sets", schema=None) as batch_op:
        batch_op.add_column(sa.Column("schema_preset_ref", JSONB_or_JSON, nullable=True))
    with op.batch_alter_table("dq_custom_checks", schema=None) as batch_op:
        batch_op.add_column(sa.Column("subcategory", sa.String(length=20), nullable=True))
        batch_op.add_column(sa.Column("origin", sa.String(length=10), nullable=False, server_default="manual"))
        batch_op.add_column(sa.Column("template_key", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("table_name", sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column("disabled", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("dq_custom_checks", schema=None) as batch_op:
        batch_op.drop_column("disabled")
        batch_op.drop_column("table_name")
        batch_op.drop_column("template_key")
        batch_op.drop_column("origin")
        batch_op.drop_column("subcategory")
    with op.batch_alter_table("dq_rule_sets", schema=None) as batch_op:
        batch_op.drop_column("schema_preset_ref")
