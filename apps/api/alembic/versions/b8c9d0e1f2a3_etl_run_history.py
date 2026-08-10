"""ETL pipeline run history

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-08-10

Pipeline runs lived only in the frontend store, so a reload erased every trace of
what had been executed against the target. This table persists them, mirroring
`dq_run_history`: one row per run, the per-script logs kept as a JSON blob since
they are written wholesale and never queried by their contents.

Indexed on pipeline_id — the only access path is "the recent runs of this
pipeline", ordered by started_at.
"""

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision = "b8c9d0e1f2a3"
down_revision = "a7b8c9d0e1f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "etl_run_history",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("pipeline_id", sa.String(length=36), nullable=False),
        sa.Column("started_at", sa.String(length=40), nullable=False),
        sa.Column("completed_at", sa.String(length=40), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("scripts", JSONB_or_JSON, nullable=True),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["pipeline_id"],
            ["etl_pipelines.id"],
            name=op.f("fk_etl_run_history_pipeline_id"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_id"],
            ["users.id"],
            name=op.f("fk_etl_run_history_created_by_id"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_etl_run_history")),
    )
    op.create_index(
        op.f("ix_etl_run_history_pipeline_id"), "etl_run_history", ["pipeline_id"]
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_etl_run_history_pipeline_id"), table_name="etl_run_history")
    op.drop_table("etl_run_history")
