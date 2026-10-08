"""data_sources: the alias is unique per workspace as DuckDB compares it

5e6f7a8b9c0d made `(workspace_id, alias)` unique, but the service refuses aliases
by their DuckDB-normalised key (`My-DB` and `my_db` mount as the same catalog), so
two concurrent creates of `My-DB` and `my_db` both passed the check and both
inserted. The key is now stored (`alias_key`, kept in sync by the model) and the
constraint is on it. 5e6f7a8b9c0d already renamed rows whose keys collided, so the
backfill cannot violate it.

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


def upgrade() -> None:
    with op.batch_alter_table("data_sources") as batch:
        batch.add_column(sa.Column("alias_key", sa.String(length=255), nullable=True))

    conn = op.get_bind()
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
