"""retire settings perm, move organizations to global

Revision ID: b29f73555fd4
Revises: b8112073e099
Create Date: 2026-07-10 08:29:05.452706

Reconciles existing role permission lists with two catalogue changes:
- "settings:*" is removed (it was an unused placeholder, never enforced).
- "organizations:*" moves from the workspace tier to the global tier. Stale
  workspace-tier org grants are stripped from every role, and the global org
  grants are added to the admin role (the default holder of instance-wide
  directory management).
Only these specific permissions are touched; any other admin edits are kept.
"""

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

import app.models.base  # noqa: F401


revision: str = 'b29f73555fd4'
down_revision: Union[str, None] = 'b8112073e099'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_REMOVE = {f"settings:{a}" for a in ("read", "write", "delete")} | {
    f"organizations:{a}" for a in ("read", "write", "delete")
}
_ADMIN_ADD = [f"organizations:{a}" for a in ("read", "write", "delete")]


def _load(perms):
    if isinstance(perms, str):
        perms = json.loads(perms)
    return list(perms or [])


def upgrade() -> None:
    conn = op.get_bind()
    roles = sa.table(
        "roles", sa.column("name", sa.String), sa.column("permissions", sa.JSON)
    )
    for name, perms in conn.execute(sa.select(roles.c.name, roles.c.permissions)):
        current = _load(perms)
        cleaned = [p for p in current if p not in _REMOVE]
        if name == "admin":
            cleaned += [p for p in _ADMIN_ADD if p not in cleaned]
        if cleaned != current:
            conn.execute(
                sa.update(roles).where(roles.c.name == name).values(permissions=cleaned)
            )


def downgrade() -> None:
    # Permission-list reconciliation; not reversed.
    pass
