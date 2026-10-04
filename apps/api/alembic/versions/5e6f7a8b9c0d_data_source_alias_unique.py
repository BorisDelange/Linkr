"""data_sources: one alias per workspace, enforced by the database

The service checked before inserting, so two concurrent creates (or an import
racing the MCP) could both pass; rows already duplicated stayed so. Duplicates
are renamed first — compared as the catalog DuckDB mounts them (`ds_` + the alias
with every non-alphanumeric as `_`, case-insensitive), the oldest keeping its
alias and the others taking `_2`, `_3`… — then the constraint goes on.

Revision ID: 5e6f7a8b9c0d
Revises: e4f5a6b7c8d9
Create Date: 2026-10-04 12:00:00.000000

"""
import re
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "5e6f7a8b9c0d"
down_revision: Union[str, None] = "e4f5a6b7c8d9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _key(alias: str) -> str:
    # Frozen copy of data_source_service.alias_key: a migration never imports app code.
    return re.sub(r"[^a-zA-Z0-9]", "_", alias).lower()


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text(
        "SELECT id, workspace_id, alias FROM data_sources "
        "WHERE workspace_id IS NOT NULL ORDER BY workspace_id, created_at, id"
    )).all()
    taken: dict[str, set[str]] = {}
    for _, workspace_id, alias in rows:
        taken.setdefault(workspace_id, set()).add(_key(alias or ""))
    seen: dict[str, set[str]] = {}
    for id_, workspace_id, alias in rows:
        alias = alias or ""
        mine = seen.setdefault(workspace_id, set())
        if _key(alias) not in mine:
            mine.add(_key(alias))
            continue
        n = 2
        while _key(f"{alias}_{n}") in taken[workspace_id]:
            n += 1
        renamed = f"{alias}_{n}"
        taken[workspace_id].add(_key(renamed))
        mine.add(_key(renamed))
        conn.execute(sa.text("UPDATE data_sources SET alias = :a WHERE id = :i"), {"a": renamed, "i": id_})

    with op.batch_alter_table("data_sources") as batch:
        batch.create_unique_constraint("uq_data_sources_workspace_alias", ["workspace_id", "alias"])


def downgrade() -> None:
    with op.batch_alter_table("data_sources") as batch:
        batch.drop_constraint("uq_data_sources_workspace_alias", type_="unique")
