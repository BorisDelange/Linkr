"""Localize dashboard tab/widget names + add descriptions

Converts dashboard_tabs.name and dashboard_widgets.name from a plain String to a
JSON column (LocalizedString), and adds nullable JSON `description` columns to both.

Existing plain-string names are wrapped as JSON scalar strings so the Postgres cast
stays valid; the frontend backfill then normalizes them to {"en": ..., "fr": ...} on
first load. SQLite stores JSON as text, so the raw string survives unchanged and is
tolerated on read (Pydantic `dict | str`).

Revision ID: b1c2d3e4f5a6
Revises: 669558a7416a
Create Date: 2026-07-15 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.models.base  # noqa: F401

# revision identifiers, used by Alembic.
revision: str = 'b1c2d3e4f5a6'
down_revision: Union[str, None] = '669558a7416a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    dialect = op.get_bind().dialect.name

    if dialect == 'postgresql':
        # Wrap the existing plain string into a JSON scalar during the type change.
        for table in ('dashboard_tabs', 'dashboard_widgets'):
            op.alter_column(
                table, 'name',
                type_=sa.JSON(),
                postgresql_using='to_jsonb(name)',
                existing_nullable=False,
            )
            op.add_column(table, sa.Column('description', sa.JSON(), nullable=True))
    else:
        # SQLite: JSON is stored as TEXT, so an in-place type swap keeps existing
        # string values byte-for-byte. batch mode recreates the table for the ALTER.
        for table in ('dashboard_tabs', 'dashboard_widgets'):
            with op.batch_alter_table(table) as batch:
                batch.alter_column('name', type_=sa.JSON(), existing_nullable=False)
                batch.add_column(sa.Column('description', sa.JSON(), nullable=True))


def downgrade() -> None:
    dialect = op.get_bind().dialect.name

    if dialect == 'postgresql':
        for table in ('dashboard_tabs', 'dashboard_widgets'):
            op.drop_column(table, 'description')
            # Best-effort: render the JSON back to text.
            op.alter_column(
                table, 'name',
                type_=sa.String(length=255),
                postgresql_using='name #>> \'{}\'',
                existing_nullable=False,
            )
    else:
        for table in ('dashboard_tabs', 'dashboard_widgets'):
            with op.batch_alter_table(table) as batch:
                batch.drop_column('description')
                batch.alter_column('name', type_=sa.String(length=255), existing_nullable=False)
