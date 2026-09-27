"""JSON columns added lately become JSONB on PostgreSQL; merge the two heads

The models declare these columns `JSONB_or_JSON`, but the migrations that added
them created plain `json` on PostgreSQL. Their migrations now create `jsonb`, so
a fresh install already has it and the conversion skips a column that is jsonb.
SQLite has a single JSON type: nothing to do there.

Also joins the two heads that branched from c4d5e6f7a8b9 (the data catalog / DQ
chain and the derivation record).

Revision ID: a37446b84515
Revises: 7a1c3e9d2b40, d7f1b3c5e9a2
Create Date: 2026-09-27 20:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "a37446b84515"
down_revision: Union[str, Sequence[str], None] = ("7a1c3e9d2b40", "d7f1b3c5e9a2")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = [
    ("data_sources", "schema_overrides"),
    ("data_catalogs", "variables"),
    ("data_catalogs", "crossings"),
    ("data_catalogs", "pages_deployment"),
    ("data_catalogs", "counts"),
    ("dq_rule_sets", "check_groups"),
]


def _retype(to_jsonb: bool) -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    inspector = sa.inspect(bind)
    for table, column in COLUMNS:
        current = next((c["type"] for c in inspector.get_columns(table) if c["name"] == column), None)
        if current is None or isinstance(current, JSONB) == to_jsonb:
            continue
        target = "JSONB" if to_jsonb else "JSON"
        op.execute(f'ALTER TABLE "{table}" ALTER COLUMN "{column}" TYPE {target} USING "{column}"::{target.lower()}')


def upgrade() -> None:
    _retype(to_jsonb=True)


def downgrade() -> None:
    _retype(to_jsonb=False)
