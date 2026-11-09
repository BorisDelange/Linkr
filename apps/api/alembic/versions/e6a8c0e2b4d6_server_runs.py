"""server_runs: concept_runs, generalised to every long computation the server
runs — one active run per kind and scope, the database optional

Revision ID: e6a8c0e2b4d6
Revises: d4f6a8c0e2b4
Create Date: 2026-11-08 20:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op
from app.models.base import PortableJSON

revision: str = "e6a8c0e2b4d6"
down_revision: Union[str, None] = "d4f6a8c0e2b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ACTIVE = "status IN ('queued', 'running', 'pausing')"
_COLUMNS = (
    "id, data_source_id, kind, scope_id, workspace_id, user_id, status, requested, spec, state, attempt, "
    "boot_id, lease_until, job_id, error, finished_at, created_at, updated_at"
)


def upgrade() -> None:
    op.create_table(
        "server_runs",
        sa.Column("data_source_id", sa.String(length=36), nullable=True),
        sa.Column("kind", sa.String(length=32), nullable=False),
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
        sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"], name=op.f("fk_server_runs_data_source_id_data_sources"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], name=op.f("fk_server_runs_workspace_id_workspaces"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_server_runs_user_id_users"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_server_runs")),
    )
    op.create_index(op.f("ix_server_runs_data_source_id"), "server_runs", ["data_source_id"])
    op.create_index(op.f("ix_server_runs_workspace_id"), "server_runs", ["workspace_id"])
    op.create_index(
        "uq_server_runs_active", "server_runs", ["kind", "scope_id"], unique=True,
        sqlite_where=sa.text(_ACTIVE), postgresql_where=sa.text(_ACTIVE),
    )
    op.execute(f"INSERT INTO server_runs ({_COLUMNS}) SELECT {_COLUMNS} FROM concept_runs")
    op.drop_index("uq_concept_runs_active", table_name="concept_runs")
    op.drop_index(op.f("ix_concept_runs_workspace_id"), table_name="concept_runs")
    op.drop_index(op.f("ix_concept_runs_data_source_id"), table_name="concept_runs")
    op.drop_table("concept_runs")


def downgrade() -> None:
    # concept_runs held only the two concept kinds, each with its database.
    op.drop_index("uq_server_runs_active", table_name="server_runs")
    op.drop_index(op.f("ix_server_runs_workspace_id"), table_name="server_runs")
    op.drop_index(op.f("ix_server_runs_data_source_id"), table_name="server_runs")
    op.rename_table("server_runs", "concept_runs_old")
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
    op.execute(
        f"INSERT INTO concept_runs ({_COLUMNS}) SELECT {_COLUMNS} FROM concept_runs_old "
        "WHERE kind IN ('stats', 'extraction') AND data_source_id IS NOT NULL"
    )
    op.drop_table("concept_runs_old")
    op.create_index(op.f("ix_concept_runs_data_source_id"), "concept_runs", ["data_source_id"])
    op.create_index(op.f("ix_concept_runs_workspace_id"), "concept_runs", ["workspace_id"])
    op.create_index(
        "uq_concept_runs_active", "concept_runs", ["data_source_id", "kind", "scope_id"], unique=True,
        sqlite_where=sa.text(_ACTIVE), postgresql_where=sa.text(_ACTIVE),
    )
