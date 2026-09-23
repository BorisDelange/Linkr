"""A database's patient boards belong to its cohorts, one each.

A database used to hold one board, shared by all its cohorts; each cohort now
has its own (`owner_cohort_id`, cascading with the cohort), still under the
database (`owner_data_source_id`) for access and cleanup. The database-wide
boards were never released, so they are dropped rather than carried over.

Revision ID: b6c7d8e9f0a1
Revises: a5b6c7d8e9f0
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b6c7d8e9f0a1"
down_revision: Union[str, None] = "a5b6c7d8e9f0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DATABASE_BOARDS = "SELECT id FROM patient_dashboards WHERE owner_data_source_id IS NOT NULL"


def _drop_database_boards() -> None:
    op.execute(
        "DELETE FROM patient_dashboard_widgets WHERE tab_id IN "
        f"(SELECT id FROM patient_dashboard_tabs WHERE patient_dashboard_id IN ({_DATABASE_BOARDS}))"
    )
    op.execute(f"DELETE FROM patient_dashboard_tabs WHERE patient_dashboard_id IN ({_DATABASE_BOARDS})")
    op.execute("DELETE FROM patient_dashboards WHERE owner_data_source_id IS NOT NULL")


def upgrade() -> None:
    _drop_database_boards()
    with op.batch_alter_table("patient_dashboards", schema=None) as batch_op:
        batch_op.add_column(sa.Column("owner_cohort_id", sa.String(length=36), nullable=True))
        batch_op.create_foreign_key(
            "fk_patient_dashboards_owner_cohort_id", "cohorts", ["owner_cohort_id"], ["id"], ondelete="CASCADE"
        )
        batch_op.create_index("ix_patient_dashboards_owner_cohort_id", ["owner_cohort_id"])


def downgrade() -> None:
    _drop_database_boards()
    with op.batch_alter_table("patient_dashboards", schema=None) as batch_op:
        batch_op.drop_index("ix_patient_dashboards_owner_cohort_id")
        batch_op.drop_constraint("fk_patient_dashboards_owner_cohort_id", type_="foreignkey")
        batch_op.drop_column("owner_cohort_id")
