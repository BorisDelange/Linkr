"""data_sources: the alias is unique per workspace as DuckDB compares it

5e6f7a8b9c0d made `(workspace_id, alias)` unique, but the service refuses aliases
by their DuckDB-normalised key (`My-DB` and `my_db` mount as the same catalog), so
two concurrent creates of `My-DB` and `my_db` both passed the check and both
inserted. The key is now stored (`alias_key`, kept in sync by the model) and the
constraint is on it. 5e6f7a8b9c0d renamed rows whose keys collided, but such a
pair could still be created between the two revisions, so the same renaming runs
again before the backfill: a collision must not block the upgrade, hence boot.

Revision ID: 7b8c9d0e1f2a
Revises: 6a7b8c9d0e1f
Create Date: 2026-10-08 12:00:01.000000

"""
import re
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "7b8c9d0e1f2a"
down_revision: Union[str, None] = "6a7b8c9d0e1f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _key(alias: str) -> str:
    # Frozen copy of data_source_service.alias_key: a migration never imports app code.
    return re.sub(r"[^a-zA-Z0-9]", "_", alias).lower()


def _rename_duplicates(conn) -> None:
    """5e6f7a8b9c0d's pass: the oldest keeps its alias, the others take `_2`, `_3`…"""
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


def upgrade() -> None:
    with op.batch_alter_table("data_sources") as batch:
        batch.add_column(sa.Column("alias_key", sa.String(length=255), nullable=True))

    conn = op.get_bind()
    _rename_duplicates(conn)
    for id_, alias in conn.execute(sa.text("SELECT id, alias FROM data_sources")).all():
        conn.execute(
            sa.text("UPDATE data_sources SET alias_key = :k WHERE id = :i"), {"k": _key(alias or ""), "i": id_}
        )

    with op.batch_alter_table("data_sources") as batch:
        batch.alter_column("alias_key", existing_type=sa.String(length=255), nullable=False)
        batch.drop_constraint("uq_data_sources_workspace_alias", type_="unique")
        batch.create_unique_constraint("uq_data_sources_workspace_alias_key", ["workspace_id", "alias_key"])


def downgrade() -> None:
    with op.batch_alter_table("data_sources") as batch:
        batch.drop_constraint("uq_data_sources_workspace_alias_key", type_="unique")
        batch.create_unique_constraint("uq_data_sources_workspace_alias", ["workspace_id", "alias"])
        batch.drop_column("alias_key")
