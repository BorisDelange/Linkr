"""dq_profiles: quality profiles (checks chosen from several rule sets, applied
to one database), and dq_run_history.profile_id for their runs

Revision ID: b3d5f7a9c1e3
Revises: a1c3e5f7b9d1
Create Date: 2026-11-09 13:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op
from app.models.base import PortableJSON

revision: str = "b3d5f7a9c1e3"
down_revision: Union[str, None] = "a1c3e5f7b9d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "dq_profiles",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("entity_id", sa.String(length=255), nullable=True),
        sa.Column("name", PortableJSON, nullable=False),
        sa.Column("description", PortableJSON, nullable=False),
        sa.Column("badges", PortableJSON, nullable=True),
        sa.Column("readme", PortableJSON, nullable=True),
        sa.Column("license", PortableJSON, nullable=True),
        sa.Column("data_source_id", sa.String(length=36), nullable=False),
        sa.Column("data_source_ref", PortableJSON, nullable=True),
        sa.Column("sources", PortableJSON, nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("last_run_at", sa.String(length=40), nullable=True),
        sa.Column("last_run_duration_ms", sa.Integer(), nullable=True),
        sa.Column("last_score", sa.Float(), nullable=True),
        sa.Column("origin", sa.String(length=10), server_default="user", nullable=False),
        sa.Column("version", sa.String(length=20), server_default="0.1.0", nullable=False),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_by_details", PortableJSON, nullable=True),
        sa.Column("organization", PortableJSON, nullable=True),
        sa.Column("lineage_id", sa.String(length=36), nullable=True),
        sa.Column("parent_lineage_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], name=op.f("fk_dq_profiles_workspace_id_workspaces"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], name=op.f("fk_dq_profiles_created_by_id_users")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_dq_profiles")),
    )
    with op.batch_alter_table("dq_run_history") as batch:
        batch.add_column(sa.Column("profile_id", sa.String(length=36), nullable=True))
        batch.create_foreign_key(
            op.f("fk_dq_run_history_profile_id_dq_profiles"), "dq_profiles", ["profile_id"], ["id"], ondelete="CASCADE",
        )


def downgrade() -> None:
    with op.batch_alter_table("dq_run_history") as batch:
        batch.drop_constraint(op.f("fk_dq_run_history_profile_id_dq_profiles"), type_="foreignkey")
        batch.drop_column("profile_id")
    op.drop_table("dq_profiles")
