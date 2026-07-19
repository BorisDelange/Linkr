"""Localize user affiliation/profession

Converts users.affiliation and users.profession from a plain String(255) to a
Text-backed LocalizedText column so they can hold a LocalizedString dict
({"en": ..., "fr": ...}). Existing plain-string values stay byte-for-byte: the
LocalizedText decoder reads a bare string when json.loads fails, so no data
transform is needed — only the column type widens (VARCHAR -> TEXT on Postgres;
a no-op affinity change on SQLite).

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-07-19 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.models.base  # noqa: F401

# revision identifiers, used by Alembic.
revision: str = 'd3e4f5a6b7c8'
down_revision: Union[str, None] = 'c2d3e4f5a6b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    dialect = op.get_bind().dialect.name

    if dialect == 'postgresql':
        # Widen VARCHAR(255) -> TEXT. Existing strings survive unchanged; the
        # LocalizedText read side tolerates them (non-JSON -> raw string).
        for column in ('affiliation', 'profession'):
            op.alter_column('users', column, type_=sa.Text(), existing_nullable=True)
    else:
        # SQLite: TEXT and VARCHAR share affinity, so existing values are kept
        # verbatim. batch mode recreates the table for the ALTER.
        with op.batch_alter_table('users') as batch:
            for column in ('affiliation', 'profession'):
                batch.alter_column(column, type_=sa.Text(), existing_nullable=True)


def downgrade() -> None:
    dialect = op.get_bind().dialect.name

    if dialect == 'postgresql':
        for column in ('affiliation', 'profession'):
            # A LocalizedString dict would render as JSON text here; a legacy
            # string round-trips unchanged.
            op.alter_column('users', column, type_=sa.String(length=255), existing_nullable=True)
    else:
        with op.batch_alter_table('users') as batch:
            for column in ('affiliation', 'profession'):
                batch.alter_column(column, type_=sa.String(length=255), existing_nullable=True)
