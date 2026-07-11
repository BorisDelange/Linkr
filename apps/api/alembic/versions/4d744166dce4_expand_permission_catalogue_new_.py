"""expand permission catalogue: new resources + ide execute

Revision ID: 4d744166dce4
Revises: 42d9cc772afb
Create Date: 2026-07-11 15:32:41.867191

Reworks the permission catalogue (see app/core/permissions.py):
- New workspace-tier resources: plugins, schemas, concept-mapping, sql-scripts,
  data-quality, catalog, etl, summary, ide, pipeline, project-databases,
  patient-data, reports; and a global-tier "workspaces".
- The old "code-execution" resource is folded into "ide": code-execution:read →
  ide:read, :write → ide:execute (the real "run code" action), :delete → ide:delete.

Two steps on the roles table:
1. Rename code-execution:* → ide:* on EVERY role (system + custom), so existing
   grants keep working under the new name.
2. Backfill the default grants of the system roles (viewer/editor/owner/admin)
   from the new catalogue — additively, so an admin's manual edits are preserved.
seed_default_roles only creates MISSING roles, so already-seeded databases would
otherwise never gain the new resources.
"""

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

import app.models.base  # noqa: F401
from app.core.permissions import (
    ALL_PERMISSIONS,
    PERMISSIONS,
    _catalogue_perms,
)


revision: str = '4d744166dce4'
down_revision: Union[str, None] = '42d9cc772afb'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# code-execution:* → ide:* (write becomes the dedicated "execute" action).
# Renames applied to EVERY role's permission list. All the source keys are old
# WORKSPACE-tier resources; the new global "workspaces:write" (create) is added
# only via the additive backfill below, so it is never produced by a rename.
_RENAME = {
    # code-execution folded into ide (write → the dedicated execute action).
    "code-execution:read": "ide:read",
    "code-execution:write": "ide:execute",
    "code-execution:delete": "ide:delete",
    # The old workspace-tier "workspaces" (manage your own workspace) is now
    # "workspace-settings"; the name "workspaces" is reused by the global tier.
    "workspaces:read": "workspace-settings:read",
    "workspaces:write": "workspace-settings:write",
    "workspaces:delete": "workspace-settings:delete",
    # "members" (workspace) renamed for symmetry with "project-members".
    "members:read": "workspace-members:read",
    "members:write": "workspace-members:write",
    "members:delete": "workspace-members:delete",
}

# The full default grant each system role should have under the new catalogue.
_DEFAULT_GRANTS = {
    "viewer": _catalogue_perms("read"),
    "editor": _catalogue_perms("write"),
    "owner": PERMISSIONS,
    "admin": ALL_PERMISSIONS,
}


def _load(raw) -> list[str]:
    if isinstance(raw, str):
        raw = json.loads(raw)
    return list(raw or [])


def upgrade() -> None:
    conn = op.get_bind()
    roles = sa.table(
        "roles", sa.column("name", sa.String), sa.column("permissions", sa.JSON)
    )
    rows = conn.execute(sa.select(roles.c.name, roles.c.permissions)).fetchall()
    for name, raw in rows:
        current = _load(raw)
        # 1. Rename code-execution:* → ide:* (dedupe, preserve order).
        renamed: list[str] = []
        for p in current:
            mapped = _RENAME.get(p, p)
            if mapped not in renamed:
                renamed.append(mapped)
        # 2. Backfill default grants for the system roles (additive).
        merged = list(renamed)
        for p in _DEFAULT_GRANTS.get(name, []):
            if p not in merged:
                merged.append(p)
        if merged != current:
            conn.execute(
                sa.update(roles).where(roles.c.name == name).values(permissions=merged)
            )


def downgrade() -> None:
    # Additive/rename migration; the reverse mapping would be lossy
    # (ide:execute vs a pre-existing ide write). Nothing to undo.
    pass
