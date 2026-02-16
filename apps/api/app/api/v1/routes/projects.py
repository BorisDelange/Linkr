from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.project import Project

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("/")
async def list_projects(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Project))
    projects = result.scalars().all()
    return [
        {
            "id": p.id,
            "uid": p.uid,
            "name": p.name,
            "description": p.description,
            "version": p.version,
            "createdAt": p.created_at.isoformat() if p.created_at else None,
        }
        for p in projects
    ]


@router.post("/")
async def create_project(
    name: dict,
    description: dict | None = None,
    db: AsyncSession = Depends(get_db),
):
    project = Project(
        name=name,
        description=description or {},
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return {"id": project.id, "uid": project.uid, "name": project.name}
