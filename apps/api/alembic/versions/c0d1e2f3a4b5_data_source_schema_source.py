"""data sources record which published schema their mapping came from

A database COPIES its schema mapping rather than referencing a preset, which is
what makes a repo self-contained. But a copy loses provenance: `schema_source`
({lineageId, label, version}) is what says which published schema it was.

The frontend has carried the field since databases became installable, and the
export writes it — but the backend had no column, and Pydantic drops unknown
fields silently. So in server mode it was accepted, discarded and never read
back: an imported database showed no schema at all on its Overview tab.

Revision ID: c0d1e2f3a4b5
Revises: b9c0d1e2f3a4
Create Date: 2026-08-26 23:20:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c0d1e2f3a4b5"
down_revision: Union[str, None] = "b9c0d1e2f3a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("data_sources", schema=None) as batch_op:
        batch_op.add_column(sa.Column("schema_source", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("data_sources", schema=None) as batch_op:
        batch_op.drop_column("schema_source")
