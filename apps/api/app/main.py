import asyncio
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings
from app.core.database import async_session
from app.core.logging import setup_logging
from app.core.migrations import run_migrations
from app.core.permissions import seed_default_roles
from app.api.v1.routes.auth import router as auth_router
from app.api.v1.routes.cohorts import router as cohorts_router
from app.api.v1.routes.concept_sets import router as concept_sets_router
from app.api.v1.routes.dashboards import router as dashboards_router
from app.api.v1.routes.attachments import readme_router, wiki_router as wiki_attachments_router
from app.api.v1.routes.ide_connections import router as ide_connections_router
from app.api.v1.routes.user_plugins import router as user_plugins_router
from app.api.v1.routes.mapping_projects import router as mapping_projects_router
from app.api.v1.routes.source_concept_ids import router as source_concept_ids_router
from app.api.v1.routes.data_catalogs import router as data_catalogs_router
from app.api.v1.routes.data_sources import router as data_sources_router
from app.api.v1.routes.database import router as database_router
from app.api.v1.routes.dq_rule_sets import router as dq_rule_sets_router
from app.api.v1.routes.etl_pipelines import router as etl_pipelines_router
from app.api.v1.routes.execution import router as execution_router
from app.api.v1.routes.environments import router as environments_router
from app.api.v1.routes.git import router as git_router
from app.api.v1.routes.dataset_files import router as dataset_files_router
from app.api.v1.routes.fs_browser import router as fs_browser_router
from app.api.v1.routes.ide_files import router as ide_files_router
from app.api.v1.routes.health import router as health_router
from app.api.v1.routes.members import router as members_router
from app.api.v1.routes.organizations import router as organizations_router
from app.api.v1.routes.pipelines import router as pipelines_router
from app.api.v1.routes.projects import router as projects_router
from app.api.v1.routes.roles import router as roles_router
from app.api.v1.routes.schema_presets import router as schema_presets_router
from app.api.v1.routes.entity_visits import router as entity_visits_router
from app.api.v1.routes.setup import router as setup_router
from app.api.v1.routes.llm_providers import router as llm_providers_router
from app.api.v1.routes.sql_scripts import router as sql_scripts_router
from app.api.v1.routes.uploads import router as uploads_router
from app.api.v1.routes.users import router as users_router
from app.api.v1.routes.wiki_pages import router as wiki_pages_router
from app.api.v1.routes.workspaces import router as workspaces_router

logger = structlog.get_logger()


_INSECURE_SECRET = "dev-secret-change-in-production"


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(debug=settings.debug)
    # The secret_key signs every JWT AND derives the Fernet key that encrypts
    # external-DB passwords at rest. Booting with the shipped default in a real
    # deployment would let anyone forge admin tokens and decrypt stored secrets.
    if settings.secret_key == _INSECURE_SECRET and not settings.debug:
        raise RuntimeError(
            "LINKR_SECRET_KEY is still the insecure default. Set a strong secret "
            "(python3 -c 'import secrets; print(secrets.token_urlsafe(48))') "
            "or run with LINKR_DEBUG=true for local development."
        )
    # A wildcard CORS origin combined with allow_credentials=True (below) would let
    # any site make credentialed requests to the API. Refuse it in production; a
    # dev run (debug) may still use it for convenience with a warning.
    if "*" in settings.cors_origin_list:
        if not settings.debug:
            raise RuntimeError(
                "LINKR_CORS_ORIGINS contains '*' while credentials are allowed. "
                "List explicit origins (e.g. https://linkr.example.org) in production, "
                "or run with LINKR_DEBUG=true for local development."
            )
        logger.warning("cors_wildcard_with_credentials", origins=settings.cors_origin_list)
    logger.info("starting_linkr", version=settings.app_version, mode=settings.app_mode)
    # Run in a worker thread: Alembic's async env.py calls asyncio.run(), which
    # cannot run inside the already-running lifespan event loop.
    await asyncio.to_thread(run_migrations)
    async with async_session() as db:
        await seed_default_roles(db)
    # A job left running when the process last died has no live task anymore →
    # reconcile it to error so the panel doesn't show a phantom 'running'.
    from app.services.execution.jobs import reconcile_on_startup

    await reconcile_on_startup()
    yield
    from app.services.execution.kernel import manager as kernel_manager
    from app.services.execution.kernel import warm_pool
    from app.services.execution.pty_kernel import manager as pty_manager

    await kernel_manager.shutdown_all()
    await warm_pool.shutdown_all()
    pty_manager.shutdown_all()
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
        except IntegrityError:
            # A unique/FK violation is a client-side conflict (e.g. importing an
            # entity whose id already exists), not a server fault — surface it as a
            # clean 409 so the client can report it instead of a misleading 500.
            logger.warning("integrity_conflict", path=request.url.path)
            return JSONResponse(
                status_code=409,
                content={"detail": "Resource already exists or violates a constraint"},
            )
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
app.include_router(database_router, prefix="/api/v1")
app.include_router(auth_router, prefix="/api/v1")
app.include_router(workspaces_router, prefix="/api/v1")
app.include_router(projects_router, prefix="/api/v1")
app.include_router(fs_browser_router, prefix="/api/v1")
app.include_router(members_router, prefix="/api/v1")
app.include_router(organizations_router, prefix="/api/v1")
app.include_router(schema_presets_router, prefix="/api/v1")
app.include_router(entity_visits_router, prefix="/api/v1")
app.include_router(llm_providers_router, prefix="/api/v1")
app.include_router(sql_scripts_router, prefix="/api/v1")
app.include_router(wiki_pages_router, prefix="/api/v1")
app.include_router(users_router, prefix="/api/v1")
app.include_router(roles_router, prefix="/api/v1")
app.include_router(uploads_router, prefix="/api/v1")
app.include_router(cohorts_router, prefix="/api/v1")
app.include_router(dashboards_router, prefix="/api/v1")
app.include_router(readme_router, prefix="/api/v1")
app.include_router(wiki_attachments_router, prefix="/api/v1")
app.include_router(dq_rule_sets_router, prefix="/api/v1")
app.include_router(data_catalogs_router, prefix="/api/v1")
app.include_router(concept_sets_router, prefix="/api/v1")
app.include_router(source_concept_ids_router, prefix="/api/v1")
app.include_router(mapping_projects_router, prefix="/api/v1")
app.include_router(ide_connections_router, prefix="/api/v1")
app.include_router(user_plugins_router, prefix="/api/v1")
app.include_router(data_sources_router, prefix="/api/v1")
app.include_router(pipelines_router, prefix="/api/v1")
app.include_router(etl_pipelines_router, prefix="/api/v1")
app.include_router(execution_router, prefix="/api/v1")
app.include_router(environments_router, prefix="/api/v1")
app.include_router(git_router, prefix="/api/v1")
app.include_router(ide_files_router, prefix="/api/v1")
app.include_router(dataset_files_router, prefix="/api/v1")
