import asyncio
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings
from app.core.database import async_session
from app.core.logging import setup_logging
from app.core.migrations import run_migrations
from app.core.permissions import seed_default_roles
from app.api.v1.routes.auth import router as auth_router
from app.api.v1.routes.datasets import router as datasets_router
from app.api.v1.routes.health import router as health_router
from app.api.v1.routes.organizations import router as organizations_router
from app.api.v1.routes.projects import router as projects_router
from app.api.v1.routes.roles import router as roles_router
from app.api.v1.routes.schema_presets import router as schema_presets_router
from app.api.v1.routes.setup import router as setup_router
from app.api.v1.routes.uploads import router as uploads_router
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

class _ErrorLoggingMiddleware(BaseHTTPMiddleware):
    """Turn unhandled exceptions into a real 500 JSON response.

    Without this, an unhandled error propagates past the CORS middleware, so the
    browser reports a misleading "CORS header missing" instead of the actual
    error. Catching here means the response still flows back through CORS and the
    client sees the real message. The traceback is logged server-side.
    """

    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except Exception:
            logger.exception("unhandled_error", path=request.url.path)
            return JSONResponse(status_code=500, content={"detail": "Internal server error"})


app.add_middleware(_ErrorLoggingMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # x-file-name carries the original filename on raw-file downloads; custom
    # response headers are invisible to JS unless explicitly exposed.
    expose_headers=["x-file-name"],
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
app.include_router(uploads_router, prefix="/api/v1")
app.include_router(datasets_router, prefix="/api/v1")
