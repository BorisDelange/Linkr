import asyncio
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.core.database import async_session
from app.core.logging import setup_logging
from app.core.migrations import run_migrations
from app.core.permissions import seed_default_roles
from app.api.v1.routes.auth import router as auth_router
from app.api.v1.routes.health import router as health_router
from app.api.v1.routes.organizations import router as organizations_router
from app.api.v1.routes.projects import router as projects_router
from app.api.v1.routes.roles import router as roles_router
from app.api.v1.routes.schema_presets import router as schema_presets_router
from app.api.v1.routes.setup import router as setup_router
from app.api.v1.routes.users import router as users_router
from app.api.v1.routes.wiki_pages import router as wiki_pages_router
from app.api.v1.routes.workspaces import router as workspaces_router

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown events."""
    setup_logging(debug=settings.debug)
    logger.info("starting_linkr", version=settings.app_version, mode=settings.app_mode)
    # Run in a worker thread: Alembic's async env.py calls asyncio.run(), which
    # cannot run inside the already-running lifespan event loop.
    await asyncio.to_thread(run_migrations)
    async with async_session() as db:
        await seed_default_roles(db)
    yield
    logger.info("shutting_down_linkr")


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routes
app.include_router(health_router, prefix="/api/v1")
app.include_router(setup_router, prefix="/api/v1")
app.include_router(auth_router, prefix="/api/v1")
app.include_router(workspaces_router, prefix="/api/v1")
app.include_router(projects_router, prefix="/api/v1")
app.include_router(organizations_router, prefix="/api/v1")
app.include_router(schema_presets_router, prefix="/api/v1")
app.include_router(wiki_pages_router, prefix="/api/v1")
app.include_router(users_router, prefix="/api/v1")
app.include_router(roles_router, prefix="/api/v1")
