"""users ids are never handed out again (SQLite AUTOINCREMENT)

Without AUTOINCREMENT, SQLite gives a new row the highest id + 1, so deleting the
most recent account frees its id for the next one, and whatever is keyed by the
id outlives the account. The table is rebuilt with AUTOINCREMENT; the copy seeds
sqlite_sequence with the highest id kept. Postgres sequences never reuse an id:
nothing to do there.

The rebuild drops the old table, so foreign keys must be off (they are, on the
connection Alembic opens): with them on, the drop would cascade into every table
referencing users.

Revision ID: 291160aa8fa3
Revises: b8d4f6a2c0e7
Create Date: 2026-11-05 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = "291160aa8fa3"
down_revision: Union[str, None] = "b8d4f6a2c0e7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _rebuild_users(autoincrement: bool) -> None:
    bind = op.get_bind()
    if bind.dialect.name != "sqlite":
        return
    if bind.exec_driver_sql("PRAGMA foreign_keys").scalar():
        raise RuntimeError("rebuilding users needs PRAGMA foreign_keys=OFF")
    with op.batch_alter_table(
        "users", recreate="always", table_kwargs={"sqlite_autoincrement": autoincrement}
    ):
        pass


def upgrade() -> None:
    _rebuild_users(True)


def downgrade() -> None:
    _rebuild_users(False)
