"""A stored database id stays inside the workspace of the entity carrying it.

The database routes check the caller's rights on the database they run on, which
says nothing of who chose it: an entity repointed at another workspace's database
runs there under the login of a member of both, and its results land where the
entity lives. So the id is refused where it is stored, and refused again where
results come back for a row stored before this rule.

An empty id (a git pointer) and an unknown one (an import that found no local
match) bind nothing and pass. Only an id that changes is checked: a client
re-saving a whole row must not fail on a field it did not touch.
"""

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import has_permission, has_project_permission
from app.models.data_source import DataSource
from app.models.mapping_project import MappingProject
from app.models.project import Project
from app.models.user import User

FOREIGN_DATABASE = "This database belongs to another workspace."
FOREIGN_STORED = (
    "This entity points at a database of another workspace, so its results cannot be stored here. "
    "Choose a database of this workspace."
)


def is_foreign(source: DataSource, workspace_id: str | None, *, allow_vocabulary: bool = False) -> bool:
    if allow_vocabulary and source.is_vocabulary_reference:
        return False
    return source.workspace_id != workspace_id


def changed_ids(entity, body, *fields: str) -> list[str]:
    """The non-empty values `body` sets on `fields`, where they differ from `entity`."""
    return [
        value
        for field in fields
        if field in body.model_fields_set
        and (value := getattr(body, field))
        and value != getattr(entity, field)
    ]


async def require_bindable(
    db: AsyncSession,
    workspace_id: str | None,
    user: User,
    source_ids: list[str | None],
    *,
    project: Project | None = None,
    allow_vocabulary: bool = False,
) -> None:
    """`user` may store these ids on an entity of `workspace_id`. Within `project`,
    the right to read a database is the caller's on that project."""
    for source_id in source_ids:
        source = await db.get(DataSource, source_id) if source_id else None
        if source is None:
            continue
        if is_foreign(source, workspace_id, allow_vocabulary=allow_vocabulary):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, FOREIGN_DATABASE)
        allowed = (
            await has_project_permission(db, project, user, "databases:read")
            if project is not None
            else await has_permission(db, workspace_id, user, "databases:read")
        )
        if not allowed:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions on this database")


async def require_stored_local(db: AsyncSession, workspace_id: str | None, *source_ids: str | None) -> None:
    """Results are about to be stored in `workspace_id` from these databases."""
    for source_id in source_ids:
        source = await db.get(DataSource, source_id) if source_id else None
        if source is not None and is_foreign(source, workspace_id):
            raise HTTPException(status.HTTP_409_CONFLICT, FOREIGN_STORED)


async def require_mapping_project_local(db: AsyncSession, workspace_id: str, mapping_project_id: str | None) -> None:
    mapping_project = await db.get(MappingProject, mapping_project_id) if mapping_project_id else None
    if mapping_project is not None and mapping_project.workspace_id != workspace_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This mapping project belongs to another workspace.")
