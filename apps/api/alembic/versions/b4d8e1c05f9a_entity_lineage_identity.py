"""standalone entities: cross-instance lineage identity

Revision ID: b4d8e1c05f9a
Revises: 9f3ac1b7e2d8
Create Date: 2026-07-13

Adds lineage_id + parent_lineage_id to the standalone exportable entities. The
lineage_id is a stable cross-instance identity, separate from the local primary
key (which may be regenerated on import/duplicate). A fork mints a new lineage_id
and records its source in parent_lineage_id. Both nullable (old rows have none;
the app backfills a lineage_id on next write).
"""
from alembic import op
import sqlalchemy as sa

revision = "b4d8e1c05f9a"
down_revision = "9f3ac1b7e2d8"
branch_labels = None
depends_on = None

_TABLES = (
    "projects",
    "workspaces",
    "sql_script_collections",
    "etl_pipelines",
    "dq_rule_sets",
    "data_catalogs",
    "mapping_projects",
)


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(table, sa.Column("lineage_id", sa.String(length=36), nullable=True))
        op.add_column(table, sa.Column("parent_lineage_id", sa.String(length=36), nullable=True))


def downgrade() -> None:
    for table in _TABLES:
        op.drop_column(table, "parent_lineage_id")
        op.drop_column(table, "lineage_id")
