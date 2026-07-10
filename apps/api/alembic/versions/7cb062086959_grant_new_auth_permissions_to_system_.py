"""grant new auth permissions to system roles

Revision ID: 7cb062086959
Revises: 41a538868a6c
Create Date: 2026-07-09 19:10:50.785668

Grants the permissions introduced with the auth work (code-execution,
project-members, app-database) to the existing default system roles.

seed_default_roles only creates MISSING roles, so on an already-seeded database
the editor/owner/admin rows keep their old permission lists and would otherwise
never gain the new resources. This backfills them once. Only the default grants
are added (never removed), so an admin's manual edits are preserved.
"""

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

import app.models.base  # noqa: F401


revision: str = '7cb062086959'
down_revision: Union[str, None] = '41a538868a6c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# The default grants introduced by this change, per system role.
_NEW_GRANTS = {
    "viewer": ["code-execution:read", "project-members:read"],
    "editor": [
        "code-execution:read", "code-execution:write",
        "project-members:read",
    ],
    "owner": [
        "code-execution:read", "code-execution:write", "code-execution:delete",
        "project-members:read", "project-members:write", "project-members:delete",
    ],
    "admin": [
        "code-execution:read", "code-execution:write", "code-execution:delete",
        "project-members:read", "project-members:write", "project-members:delete",
        "app-database:read", "app-database:write", "app-database:delete",
    ],
}


def upgrade() -> None:
    conn = op.get_bind()
    roles = sa.table(
        "roles", sa.column("name", sa.String), sa.column("permissions", sa.JSON)
    )
    for name, grants in _NEW_GRANTS.items():
        row = conn.execute(
            sa.select(roles.c.permissions).where(roles.c.name == name)
        ).first()
        if row is None:
            continue  # role not seeded on this instance; seed handles it
        current = row[0]
        # JSON column may come back as a str on some backends.
        if isinstance(current, str):
            current = json.loads(current)
        current = list(current or [])
        merged = current + [p for p in grants if p not in current]
        if merged != current:
            conn.execute(
                sa.update(roles).where(roles.c.name == name).values(permissions=merged)
            )


def downgrade() -> None:
    # Permission grants are additive and safe to keep; nothing to undo.
    pass
