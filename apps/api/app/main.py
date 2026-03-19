from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.core.database import init_db
from app.core.logging import setup_logging
from app.api.v1.routes.auth import router as auth_router
from app.api.v1.routes.health import router as health_router
from app.api.v1.routes.projects import router as projects_router
from app.api.v1.routes.setup import router as setup_router

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown events."""
    setup_logging(debug=settings.debug)
    logger.info("starting_linkr", version=settings.app_version, mode=settings.app_mode)
    await init_db()
    yield
    logger.info("shutting_down_linkr")


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    lifespan=lifespan,
)

# CORS (development)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routes
app.include_router(health_router, prefix="/api/v1")
app.include_router(setup_router, prefix="/api/v1")
app.include_router(auth_router, prefix="/api/v1")
app.include_router(projects_router, prefix="/api/v1")
