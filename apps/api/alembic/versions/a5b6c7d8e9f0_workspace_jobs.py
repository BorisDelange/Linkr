"""Jobs owned by a workspace instead of a project.

A cohort's derivation runs as a job, and it belongs to a database — a workspace
entity, outside any project. Each job now has exactly one owner: `project_uid`
(environment builds, batch runs) or `workspace_id` (derivations). The second
cascades with the workspace, as the first does with the project.

No backfill: every existing job keeps its project.

Revision ID: a5b6c7d8e9f0
Revises: f4a5b6c7d8e9
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a5b6c7d8e9f0"
down_revision: Union[str, None] = "f4a5b6c7d8e9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("jobs", schema=None) as batch_op:
        batch_op.alter_column("project_uid", existing_type=sa.String(length=36), nullable=True)
        batch_op.add_column(sa.Column("workspace_id", sa.String(length=36), nullable=True))
        batch_op.create_foreign_key(
            "fk_jobs_workspace_id", "workspaces", ["workspace_id"], ["id"], ondelete="CASCADE"
        )
        batch_op.create_index("ix_jobs_workspace_id", ["workspace_id"])


def downgrade() -> None:
    op.execute("DELETE FROM jobs WHERE project_uid IS NULL")
    with op.batch_alter_table("jobs", schema=None) as batch_op:
        batch_op.drop_index("ix_jobs_workspace_id")
        batch_op.drop_constraint("fk_jobs_workspace_id", type_="foreignkey")
        batch_op.drop_column("workspace_id")
        batch_op.alter_column("project_uid", existing_type=sa.String(length=36), nullable=False)
