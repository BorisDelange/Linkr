"""The API surface the R/Python client libraries call from inside a kernel.

A script running in the IDE reaches its project through ``linkr_databases()`` /
``linkr_connect()``; those call here, authenticating with the LINKR_TOKEN this
project's kernel was started with (see ``create_kernel_token``). Paths need no
endpoint — they arrive as LINKR_* environment variables — so this module is only
about databases, which live in the server's DB and have no on-disk answer.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_kernel_user
from app.core.permissions import has_permission
from app.models.project import Project
from app.models.user import User
from app.schemas.data_source import ClientDatabase
from app.services import data_source_service

router = APIRouter(prefix="/projects/{project_uid}/client", tags=["client-lib"])


@router.get("/databases", response_model=list[ClientDatabase])
async def list_databases(
    project_uid: str,
    user: User = Depends(get_kernel_user),
    db: AsyncSession = Depends(get_db),
):
    """The databases a script in this project may open, each with the recipe for
    opening it.

    Filtered to the sources the caller holds ``databases:read`` on, so a script
    reaches exactly what its user reaches in the UI — never more. For an external
    engine the recipe carries the decrypted password, because the ATTACH runs in
    the script's own process and that is the only way to hand back a real DBI /
    DBAPI handle rather than a query proxy.

    That is a deliberate trade, and it is narrow: the secret goes only to someone
    who can already read the same data through the app, running code they wrote,
    on a machine that already holds the key. It does NOT widen reach — a source
    the user cannot read is not listed and has no recipe. What it does concede is
    that such a user can recover the stored password for a database they are
    entitled to query. Encryption at rest still protects the secret everywhere
    else: on disk, in backups, and in every other API response.
    """
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if project.workspace_id is None:
        return []
    if not await has_permission(db, project.workspace_id, user, "databases:read"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Insufficient workspace permissions"
        )

    sources = await data_source_service.list_for_workspace(db, project.workspace_id)
    return [
        ClientDatabase(
            id=source.id,
            name=source.name,
            **await data_source_service.client_recipe(db, source),
        )
        for source in sources
    ]
