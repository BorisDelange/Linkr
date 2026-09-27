"""data catalogs choose which variables are shown alone

A crossing may now name a single variable: the variables shown on their own.
Every enabled variable's 1-way count was published before, so each existing
catalog gets one single-variable crossing per enabled variable and reads as
it did.

Revision ID: d7f1b3c5e9a2
Revises: c4e8a2f6d1b3
Create Date: 2026-09-27 21:00:00.000000

"""
import json
from typing import Any, Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d7f1b3c5e9a2"
down_revision: Union[str, None] = "c4e8a2f6d1b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ORDER = ["concept", "period", "service", "age", "sex"]


def _load(value: Any) -> Any:
    # SQLite hands JSON back as text.
    return json.loads(value) if isinstance(value, str) else value


def with_singles(variables: Any, crossings: Any) -> list:
    variables = _load(variables) or {}
    out = [list(c) for c in (_load(crossings) or []) if isinstance(c, list)]
    present = {tuple(c) for c in out}
    singles = [[v] for v in ORDER if isinstance(variables.get(v), dict) and variables[v].get("enabled") and (v,) not in present]
    return singles + out


def upgrade() -> None:
    bind = op.get_bind()
    table = sa.table("data_catalogs", sa.column("id", sa.String), sa.column("variables", sa.JSON), sa.column("crossings", sa.JSON))
    for row in bind.execute(sa.select(table.c.id, table.c.variables, table.c.crossings)).fetchall():
        bind.execute(table.update().where(table.c.id == row.id).values(crossings=with_singles(row.variables, row.crossings)))


def downgrade() -> None:
    # Single-variable crossings were implicit before: dropping them loses nothing.
    bind = op.get_bind()
    table = sa.table("data_catalogs", sa.column("id", sa.String), sa.column("crossings", sa.JSON))
    for row in bind.execute(sa.select(table.c.id, table.c.crossings)).fetchall():
        kept = [c for c in (_load(row.crossings) or []) if isinstance(c, list) and len(c) > 1]
        bind.execute(table.update().where(table.c.id == row.id).values(crossings=kept))
