"""viewer loses render execute (read-only sees code-less widgets only)

Revision ID: 0e1743d6bfc2
Revises: d4e5f6a7b8c9
Create Date: 2026-07-12 11:46:25.698166

Refines the render-execute model: "execute" (dashboards/datasets/patient-data) now
means running R/Python code, so it belongs to editor+, not viewer. A viewer sees
code-less (component) widgets/analyses but not code-backed ones. This reverts the
earlier over-grant (e9e7ec8fd6eb) that gave viewer these executes. Touches ONLY the
"viewer" system role; other roles keep whatever they hold.
"""

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

import app.models.base  # noqa: F401


revision: str = '0e1743d6bfc2'
down_revision: Union[str, None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_REMOVE_FROM_VIEWER = {
    "dashboards:execute",
    "datasets:execute",
    "patient-data:execute",
}


def upgrade() -> None:
    conn = op.get_bind()
    roles = sa.table(
        "roles", sa.column("name", sa.String), sa.column("permissions", sa.JSON)
    )
    row = conn.execute(
        sa.select(roles.c.permissions).where(roles.c.name == "viewer")
    ).first()
    if row is None:
        return
    current = row[0]
    if isinstance(current, str):
        current = json.loads(current)
    current = list(current or [])
    kept = [p for p in current if p not in _REMOVE_FROM_VIEWER]
    if kept != current:
        conn.execute(
            sa.update(roles).where(roles.c.name == "viewer").values(permissions=kept)
        )


def downgrade() -> None:
    pass
