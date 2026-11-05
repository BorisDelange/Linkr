"""databases without a workspace take the workspace of a project linking them

A database with no workspace reaches nobody but admins. Each one moves to the
workspace of the earliest project that links it. One that no project links, or
whose alias that workspace already uses, stays as it is and is logged.

Revision ID: c4e6a8b0d2f1
Revises: 291160aa8fa3
Create Date: 2026-11-05 15:00:00.000000

"""
import logging
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.models.base import PortableJSON

revision: str = "c4e6a8b0d2f1"
down_revision: Union[str, None] = "291160aa8fa3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

log = logging.getLogger("alembic.runtime.migration")

_data_sources = sa.table(
    "data_sources",
    sa.column("id", sa.String),
    sa.column("alias", sa.String),
    sa.column("alias_key", sa.String),
    sa.column("workspace_id", sa.String),
)
_projects = sa.table(
    "projects",
    sa.column("uid", sa.String),
    sa.column("workspace_id", sa.String),
    sa.column("linked_data_source_ids", PortableJSON),
    sa.column("created_at", sa.DateTime),
)


def upgrade() -> None:
    conn = op.get_bind()
    orphans = conn.execute(
        sa.select(_data_sources.c.id, _data_sources.c.alias, _data_sources.c.alias_key)
        .where(_data_sources.c.workspace_id.is_(None))
        .order_by(_data_sources.c.id)
    ).all()
    if not orphans:
        return

    first_workspace: dict[str, str] = {}
    projects = conn.execute(
        sa.select(_projects.c.workspace_id, _projects.c.linked_data_source_ids)
        .where(_projects.c.workspace_id.is_not(None))
        .order_by(_projects.c.created_at, _projects.c.uid)
    ).all()
    for workspace_id, linked in projects:
        for ds_id in linked if isinstance(linked, list) else []:
            if isinstance(ds_id, str):
                first_workspace.setdefault(ds_id, workspace_id)

    taken = {
        (workspace_id, alias_key)
        for workspace_id, alias_key in conn.execute(
            sa.select(_data_sources.c.workspace_id, _data_sources.c.alias_key)
            .where(_data_sources.c.workspace_id.is_not(None))
        )
    }
    for ds_id, alias, alias_key in orphans:
        workspace_id = first_workspace.get(ds_id)
        if workspace_id is None:
            log.warning("database %s (%s) is linked by no project: left without a workspace (admins only)", ds_id, alias)
            continue
        if (workspace_id, alias_key) in taken:
            log.warning(
                "database %s (%s): workspace %s already has a database with that alias: "
                "left without a workspace (admins only)", ds_id, alias, workspace_id,
            )
            continue
        conn.execute(
            _data_sources.update().where(_data_sources.c.id == ds_id).values(workspace_id=workspace_id)
        )
        taken.add((workspace_id, alias_key))
        log.info("database %s (%s) moved to workspace %s", ds_id, alias, workspace_id)


def downgrade() -> None:
    pass
