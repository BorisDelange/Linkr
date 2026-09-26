"""What a derivation created, recorded server-side

`data_sources.linkr_created` is the server's own record of what a cohort
derivation created on this instance (a derived file, schemas derived into a
database, the schema a declared database points at): what a rebuild may
replace and a delete may drop. `derived_from` stays provenance for display —
clients send it, and imports carry it — so it is no longer trusted for that.

Backfilled from what the server itself wrote so far: the provenance of derived
databases, and the cohorts' records of schemas derived into a database.

Revision ID: 7a1c3e9d2b40
Revises: c4d5e6f7a8b9
Create Date: 2026-09-25 18:00:00
"""
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "7a1c3e9d2b40"
down_revision: Union[str, None] = "c4d5e6f7a8b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _parsed(value):
    if isinstance(value, str) and value:
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def _server(config: dict) -> list:
    return [config.get("engine"), config.get("host"), config.get("port"), config.get("database")]


def upgrade() -> None:
    with op.batch_alter_table("data_sources", schema=None) as batch_op:
        batch_op.add_column(sa.Column("linkr_created", JSONB_or_JSON, nullable=True))

    bind = op.get_bind()
    sources = sa.table("data_sources", sa.column("id", sa.String), sa.column("linkr_created", JSONB_or_JSON))
    created: dict[str, dict] = {}
    for row_id, config, derived in bind.execute(
        sa.text("SELECT id, connection_config, derived_from FROM data_sources WHERE derived_from IS NOT NULL")
    ).all():
        config, derived = _parsed(config) or {}, _parsed(derived) or {}
        if not isinstance(config, dict) or not isinstance(derived, dict):
            continue
        schema = derived.get("schemaName")
        if schema and config.get("schema") == schema and config.get("engine") not in (None, "duckdb"):
            created[row_id] = {"schema": schema, "server": _server(config)}
        elif config.get("managed"):
            created[row_id] = {"file": True}
    for (derivations,) in bind.execute(
        sa.text("SELECT derivations FROM cohorts WHERE derivations IS NOT NULL")
    ).all():
        for d in _parsed(derivations) or []:
            if isinstance(d, dict) and d.get("kind") == "schema" and d.get("targetId") and d.get("schemaName"):
                entry = created.setdefault(d["targetId"], {})
                entry["schemas"] = sorted({*entry.get("schemas", []), d["schemaName"]})
    for row_id, value in created.items():
        bind.execute(sa.update(sources).where(sources.c.id == row_id).values(linkr_created=value))


def downgrade() -> None:
    with op.batch_alter_table("data_sources", schema=None) as batch_op:
        batch_op.drop_column("linkr_created")
