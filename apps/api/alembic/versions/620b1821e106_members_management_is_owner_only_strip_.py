"""members management is owner-only (strip from editor viewer)

Revision ID: 620b1821e106
Revises: e5f6a7b8c9d0
Create Date: 2026-07-12 19:10:28.275816

Membership management (write/delete on workspace-members / project-members) is an
owner responsibility. An earlier backfill granted write/delete to the default
editor role; remove them so only owner (and admin) can modify members. READ stays
(editor/viewer may see the member list). Touches ONLY "editor"/"viewer".
"""

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

import app.models.base  # noqa: F401


revision: str = '620b1821e106'
down_revision: Union[str, None] = 'e5f6a7b8c9d0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_STRIP = {
    "workspace-members:write", "workspace-members:delete",
    "project-members:write", "project-members:delete",
}


def upgrade() -> None:
    conn = op.get_bind()
    roles = sa.table(
        "roles", sa.column("name", sa.String), sa.column("permissions", sa.JSON)
    )
    for name in ("editor", "viewer"):
        row = conn.execute(
            sa.select(roles.c.permissions).where(roles.c.name == name)
        ).first()
        if row is None:
            continue
        current = row[0]
        if isinstance(current, str):
            current = json.loads(current)
        current = list(current or [])
        kept = [p for p in current if p not in _STRIP]
        if kept != current:
            conn.execute(
                sa.update(roles).where(roles.c.name == name).values(permissions=kept)
            )


def downgrade() -> None:
    pass
