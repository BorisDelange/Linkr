"""grant render execute perms (dashboards datasets patient-data)

Revision ID: e9e7ec8fd6eb
Revises: c3d4e5f6a7b8
Create Date: 2026-07-12 11:09:26.667271

Adds the new render-execute permissions (dashboards:execute, datasets:execute,
patient-data:execute) to the default system roles. These gate rendering a widget /
analysis (running its author-defined code) separately from ide:execute. viewer+ hold
them by default (rendering is a view-time operation). Additive only — an admin's
manual edits to a role's permission list are preserved.
"""

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

import app.models.base  # noqa: F401
from app.core.permissions import ALL_PERMISSIONS, PERMISSIONS, _catalogue_perms


revision: str = 'e9e7ec8fd6eb'
down_revision: Union[str, None] = 'c3d4e5f6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# The new render-execute grants, by system role. Derived from the catalogue so it
# stays in sync: viewer gets the render executes; editor/owner/admin get all.
_NEW = {
    "viewer": [p for p in _catalogue_perms("read") if p.endswith(":execute")],
    "editor": [p for p in _catalogue_perms("write") if p.endswith(":execute")],
    "owner": [p for p in PERMISSIONS if p.endswith(":execute")],
    "admin": [p for p in ALL_PERMISSIONS if p.endswith(":execute")],
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
    for name, grants in _NEW.items():
        row = conn.execute(
            sa.select(roles.c.permissions).where(roles.c.name == name)
        ).first()
        if row is None:
            continue
        current = _load(row[0])
        merged = current + [p for p in grants if p not in current]
        if merged != current:
            conn.execute(
                sa.update(roles).where(roles.c.name == name).values(permissions=merged)
            )


def downgrade() -> None:
    # Additive grant; safe to leave in place.
    pass
