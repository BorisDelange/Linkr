"""a database login has a purpose: the user's own account (read) or the one a cohort derivation writes with (write)

SQL Server, Oracle and Doris logins are checked read-only at every attach; a
derivation into one of those databases writes with a second account, kept apart.

Revision ID: f5b7d9e1a3c6
Revises: e3a5c7e9b1d4
Create Date: 2026-11-03 19:30:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f5b7d9e1a3c6"
down_revision: Union[str, None] = "e3a5c7e9b1d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("database_credentials", schema=None) as batch_op:
        batch_op.add_column(sa.Column("purpose", sa.String(length=8), server_default="read", nullable=False))
        batch_op.drop_constraint("uq_database_credential_user_source", type_="unique")
        batch_op.create_unique_constraint(
            "uq_database_credential_user_source_purpose", ["user_id", "data_source_id", "purpose"],
        )


def downgrade() -> None:
    op.execute("DELETE FROM database_credentials WHERE purpose <> 'read'")
    with op.batch_alter_table("database_credentials", schema=None) as batch_op:
        batch_op.drop_constraint("uq_database_credential_user_source_purpose", type_="unique")
        batch_op.create_unique_constraint("uq_database_credential_user_source", ["user_id", "data_source_id"])
        batch_op.drop_column("purpose")
