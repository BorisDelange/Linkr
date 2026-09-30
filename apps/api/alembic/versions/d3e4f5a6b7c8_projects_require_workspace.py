"""projects require a workspace

A project without a workspace resolved to "owner" for every user, which handed
ide:execute (and so the server) to any account. Each unassigned project moves to
a personal workspace of its owner — nobody else gains access — and one with no
owner to a memberless workspace only admins reach. Then the column is NOT NULL.

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-09-30 12:00:00.000000

"""
import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import JSONB_or_JSON

revision: str = "d3e4f5a6b7c8"
down_revision: Union[str, None] = "c2d3e4f5a6b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_projects = sa.table(
    "projects",
    sa.column("uid", sa.String),
    sa.column("owner_id", sa.Integer),
    sa.column("workspace_id", sa.String),
)
_users = sa.table("users", sa.column("id", sa.Integer), sa.column("username", sa.String))
_workspaces = sa.table(
    "workspaces",
    sa.column("id", sa.String),
    sa.column("name", JSONB_or_JSON),
    sa.column("description", JSONB_or_JSON),
    sa.column("owner_id", sa.Integer),
    sa.column("origin", sa.String),
)
_members = sa.table(
    "workspace_members",
    sa.column("workspace_id", sa.String),
    sa.column("user_id", sa.Integer),
    sa.column("role", sa.String),
)


def upgrade() -> None:
    conn = op.get_bind()
    orphans = conn.execute(
        sa.select(_projects.c.uid, _projects.c.owner_id).where(_projects.c.workspace_id.is_(None))
    ).all()
    target_by_owner: dict[int | None, str] = {}
    for uid, owner_id in orphans:
        if owner_id not in target_by_owner:
            username = None
            if owner_id is not None:
                username = conn.scalar(sa.select(_users.c.username).where(_users.c.id == owner_id))
            ws_id = str(uuid.uuid4())
            label = f"{username}'s projects" if username else "Unassigned projects"
            label_fr = f"Projets de {username}" if username else "Projets non assignés"
            conn.execute(_workspaces.insert().values(
                id=ws_id, name={"en": label, "fr": label_fr}, description={},
                owner_id=owner_id if username else None, origin="user",
            ))
            if username:
                conn.execute(_members.insert().values(workspace_id=ws_id, user_id=owner_id, role="owner"))
            target_by_owner[owner_id] = ws_id
        conn.execute(
            _projects.update().where(_projects.c.uid == uid).values(workspace_id=target_by_owner[owner_id])
        )
    with op.batch_alter_table("projects") as batch:
        batch.alter_column("workspace_id", existing_type=sa.String(36), nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("projects") as batch:
        batch.alter_column("workspace_id", existing_type=sa.String(36), nullable=True)
