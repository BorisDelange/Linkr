"""jobs are read by owner, user and date: the panel's list and the query log's prune

Revision ID: a7c3e5f1b9d2
Revises: f5b7d9e1a3c6
Create Date: 2026-11-04 08:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = "a7c3e5f1b9d2"
down_revision: Union[str, None] = "f5b7d9e1a3c6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("ix_jobs_workspace_user_created", "jobs", ["workspace_id", "user_id", "created_at"])
    op.create_index("ix_jobs_project_user_created", "jobs", ["project_uid", "user_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_jobs_project_user_created", table_name="jobs")
    op.drop_index("ix_jobs_workspace_user_created", table_name="jobs")
