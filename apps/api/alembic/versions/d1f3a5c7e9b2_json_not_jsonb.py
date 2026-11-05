"""every JSON column is plain JSON on PostgreSQL, never JSONB

JSONB reorders an object's keys, so an export from a Postgres install differed
from the same entity exported by the browser or a SQLite server (a false diff in
git, the export goldens failing). No query relies on a JSONB operator. SQLite has
a single JSON type: nothing to do there.

Revision ID: d1f3a5c7e9b2
Revises: c7e1f3a5b9d2
Create Date: 2026-11-03 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d1f3a5c7e9b2"
down_revision: Union[str, None] = "c7e1f3a5b9d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _jsonb_columns(bind) -> list[tuple[str, str]]:
    rows = bind.execute(sa.text(
        "SELECT table_name, column_name FROM information_schema.columns "
        "WHERE table_schema = current_schema() AND data_type = 'jsonb' ORDER BY 1, 2"
    ))
    return [(r[0], r[1]) for r in rows]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    for table, column in _jsonb_columns(bind):
        op.execute(f'ALTER TABLE "{table}" ALTER COLUMN "{column}" TYPE JSON USING "{column}"::json')


def downgrade() -> None:
    # The key order JSONB would lose is not worth getting back: nothing to undo.
    pass
