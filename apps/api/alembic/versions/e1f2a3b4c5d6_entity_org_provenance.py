"""standalone entities: organization provenance snapshot

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-07-13

Adds a frozen organization provenance snapshot to the standalone exportable
entities (SQL collections, ETL pipelines, DQ rule sets, data catalogs). Like
created_by / created_by_details, this is an immutable snapshot inlined at export
and kept verbatim on import — NOT a live link to a local organization (that
stays a workspace-only concept via workspaces.organization_id). projects already
carry an `organization` column from the initial schema, so it isn't added here.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "e1f2a3b4c5d6"
down_revision = "d0e1f2a3b4c5"
branch_labels = None
depends_on = None

_JSON = postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite")

_TABLES = (
    "sql_script_collections",
    "etl_pipelines",
    "dq_rule_sets",
    "data_catalogs",
)


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(table, sa.Column("organization", _JSON, nullable=True))


def downgrade() -> None:
    for table in _TABLES:
        op.drop_column(table, "organization")
