"""authored entities: author provenance

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-07-13

Extends creator provenance (added to projects in c9d0e1f2a3b4) to the remaining
Authored entities. Group A (workspaces, data_sources, dataset_files) gain the
full trio (created_by_id + created_by / created_by_details display snapshot),
except data_sources which already had created_by. Group B (data_catalogs,
dashboards, wiki_pages, etl_pipelines, dq_rule_sets, sql_script_collections)
already carried the display snapshot and only gain the stable created_by_id.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "d0e1f2a3b4c5"
down_revision = "c9d0e1f2a3b4"
branch_labels = None
depends_on = None

_JSON = postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite")


def upgrade() -> None:
    # Group A — full trio (data_sources already has created_by).
    op.add_column("workspaces", sa.Column("created_by_id", sa.Integer(), nullable=True))
    op.add_column("workspaces", sa.Column("created_by", sa.Text(), nullable=True))
    op.add_column("workspaces", sa.Column("created_by_details", _JSON, nullable=True))

    op.add_column("data_sources", sa.Column("created_by_id", sa.Integer(), nullable=True))
    op.add_column("data_sources", sa.Column("created_by_details", _JSON, nullable=True))

    op.add_column("dataset_files", sa.Column("created_by_id", sa.Integer(), nullable=True))
    op.add_column("dataset_files", sa.Column("created_by", sa.Text(), nullable=True))
    op.add_column("dataset_files", sa.Column("created_by_details", _JSON, nullable=True))

    # Group B — created_by_id only (display snapshot already present).
    op.add_column("data_catalogs", sa.Column("created_by_id", sa.Integer(), nullable=True))
    op.add_column("dashboards", sa.Column("created_by_id", sa.Integer(), nullable=True))
    op.add_column("wiki_pages", sa.Column("created_by_id", sa.Integer(), nullable=True))
    op.add_column("etl_pipelines", sa.Column("created_by_id", sa.Integer(), nullable=True))
    op.add_column("dq_rule_sets", sa.Column("created_by_id", sa.Integer(), nullable=True))
    op.add_column(
        "sql_script_collections", sa.Column("created_by_id", sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("sql_script_collections", "created_by_id")
    op.drop_column("dq_rule_sets", "created_by_id")
    op.drop_column("etl_pipelines", "created_by_id")
    op.drop_column("wiki_pages", "created_by_id")
    op.drop_column("dashboards", "created_by_id")
    op.drop_column("data_catalogs", "created_by_id")

    op.drop_column("dataset_files", "created_by_details")
    op.drop_column("dataset_files", "created_by")
    op.drop_column("dataset_files", "created_by_id")

    op.drop_column("data_sources", "created_by_details")
    op.drop_column("data_sources", "created_by_id")

    op.drop_column("workspaces", "created_by_details")
    op.drop_column("workspaces", "created_by")
    op.drop_column("workspaces", "created_by_id")
