"""server_runs.principal: whose view of the database a run's results are — ""
for every reader, `user:<id>` for one read with that user's own login; one
active run per kind, scope and principal

Revision ID: 744a4dcee357
Revises: d6f8a0c2e4b6
Create Date: 2026-11-16 10:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "744a4dcee357"
down_revision: Union[str, None] = "d6f8a0c2e4b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ACTIVE = "status IN ('queued', 'running', 'pausing')"
# registry.Kind.per_login, as of this revision.
_PER_LOGIN_KINDS = ("etl_quality", "database_stats", "cohort_run", "cohort_figures")


def upgrade() -> None:
    op.add_column("server_runs", sa.Column("principal", sa.String(length=64), server_default="", nullable=False))
    op.drop_index("uq_server_runs_active", table_name="server_runs")
    # Whether such a run read a file database or its starter's own login is not
    # recorded: it is kept as its starter's.
    op.execute(
        "UPDATE server_runs SET principal = 'user:' || CAST(user_id AS VARCHAR(20)) "
        f"WHERE kind IN ({', '.join(repr(k) for k in _PER_LOGIN_KINDS)}) AND data_source_id IS NOT NULL"
    )
    op.create_index(
        "uq_server_runs_active", "server_runs", ["kind", "scope_id", "principal"], unique=True,
        sqlite_where=sa.text(_ACTIVE), postgresql_where=sa.text(_ACTIVE),
    )


def downgrade() -> None:
    # A user's own runs cannot be told from the shared ones without the column.
    op.execute("DELETE FROM server_runs WHERE principal <> ''")
    op.drop_index("uq_server_runs_active", table_name="server_runs")
    with op.batch_alter_table("server_runs") as batch:
        batch.drop_column("principal")
    op.create_index(
        "uq_server_runs_active", "server_runs", ["kind", "scope_id"], unique=True,
        sqlite_where=sa.text(_ACTIVE), postgresql_where=sa.text(_ACTIVE),
    )
