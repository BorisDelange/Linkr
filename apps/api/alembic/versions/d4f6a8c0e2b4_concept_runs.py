"""concept_runs: a database's concept statistics or a mapping project's
extraction, run by the server

Revision ID: d4f6a8c0e2b4
Revises: c7e1a3f5b9d2
Create Date: 2026-11-08 14:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op
from app.models.base import PortableJSON

revision: str = "d4f6a8c0e2b4"
down_revision: Union[str, None] = "c7e1a3f5b9d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ACTIVE = "status IN ('queued', 'running', 'pausing')"


def upgrade() -> None:
    op.create_table(
        "concept_runs",
        sa.Column("data_source_id", sa.String(length=36), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("scope_id", sa.String(length=64), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("requested", sa.String(length=16), nullable=True),
        sa.Column("spec", PortableJSON, nullable=False),
        sa.Column("state", PortableJSON, nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("boot_id", sa.String(length=36), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("job_id", sa.String(length=36), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"], name=op.f("fk_concept_runs_data_source_id_data_sources"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], name=op.f("fk_concept_runs_workspace_id_workspaces"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_concept_runs_user_id_users"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_concept_runs")),
    )
    op.create_index(op.f("ix_concept_runs_data_source_id"), "concept_runs", ["data_source_id"])
    op.create_index(op.f("ix_concept_runs_workspace_id"), "concept_runs", ["workspace_id"])
    op.create_index(
        "uq_concept_runs_active", "concept_runs", ["data_source_id", "kind", "scope_id"], unique=True,
        sqlite_where=sa.text(_ACTIVE), postgresql_where=sa.text(_ACTIVE),
    )


def downgrade() -> None:
    op.drop_index("uq_concept_runs_active", table_name="concept_runs")
    op.drop_index(op.f("ix_concept_runs_workspace_id"), table_name="concept_runs")
    op.drop_index(op.f("ix_concept_runs_data_source_id"), table_name="concept_runs")
    op.drop_table("concept_runs")
