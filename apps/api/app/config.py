from functools import cached_property
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings

# apps/api/.env — resolved absolutely so it loads regardless of the working
# directory uvicorn is launched from (config.py lives at apps/api/app/config.py).
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # App
    app_name: str = "Linkr"
    app_version: str = "2.0.0-dev"
    debug: bool = False
    app_mode: str = "full"  # full, dashboard, viewer

    # Database — leave unset to default to a SQLite file inside data_dir
    # (so the database and binary blobs live together in one dedicated folder).
    database_url: str | None = None

    # Auth
    secret_key: str = "dev-secret-change-in-production"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24  # 24 hours
    refresh_token_expire_days: int = 30
    auth_provider: str = "local"  # local, ldap, oidc, saml (only local implemented)

    # CORS — comma-separated string in env; exposed as a list via cors_origin_list.
    cors_origins: str = "http://localhost:3000"

    # Uploads — hard cap on a single assembled upload (raw files, DB imports).
    # Guards the blob store's disk against an authenticated user filling it.
    max_upload_mb: int = 2048  # 2 GB

    # Code execution
    enable_code_execution: bool = True
    # Cap on a user's concurrent live server processes (R/Python kernels + PTY
    # shells). Renamed from MAX_SESSIONS_PER_USER (still read as a fallback so
    # existing deployments' env vars keep working) once "session" stopped meaning
    # the interpreter — a session is now a namespace over an environment.
    max_kernels_per_user: int = Field(
        default=5,
        validation_alias=AliasChoices("max_kernels_per_user", "max_sessions_per_user"),
    )
    session_timeout_minutes: int = 60
    # Hard wall-clock limit for a single server-side R/Python run (subprocess).
    execution_timeout_seconds: int = 120

    # Managed environments (uv for Python; renv for R lands with step 5). The uv
    # binary and PyPI index stay configurable so a future internal mirror is a
    # config change, not a re-architecture (see ide-environments-plan §1). The
    # package cache is Linkr-wide: one copy of each (package, version) shared by
    # every project's venv, under data_dir/.cache/uv (uv hardlinks from it).
    uv_bin: str = "uv"
    pip_index_url: str = "https://pypi.org/simple"
    # R managed environments (renv). Rscript binary + package repo stay configurable
    # (default p3m: public, Docker-independent, ships binaries so Linux servers don't
    # compile from source). renv's cache is pointed at the Linkr-wide store so a
    # version installed for one project is reused by the next.
    rscript_bin: str = "Rscript"
    r_repos: str = "https://packagemanager.posit.co/cran/latest"
    # Bounded in-process executor for long jobs (env builds): how many run at once
    # before the rest queue. Keeps a burst from exhausting the single uvicorn
    # worker. A real queue (celery/RQ) is only needed if load outgrows this.
    max_build_concurrency: int = 2
    # Hard wall-clock limit for a single env build (uv sync / renv restore). A hung
    # build otherwise holds a max_build_concurrency slot forever, wedging all builds.
    build_timeout_seconds: int = 1800

    # Data
    data_dir: str = "~/.linkr"

    # Server file-browser (project Folders settings): comma-separated absolute
    # roots the browser may traverse when picking an ide_path/datasets_path. Empty
    # = the whole filesystem (confinement is the deployment's job — mount only what
    # the server should reach, like RStudio Server). Set e.g.
    # LINKR_FS_BROWSE_ROOTS="/home,/data" to restrict.
    fs_browse_roots: str = ""

    # Server-side query engine: how long a warm DuckDB connection to a data
    # source is kept alive between queries before it is closed for inactivity.
    pool_ttl_seconds: int = 300

    model_config = {"env_prefix": "LINKR_", "env_file": str(_ENV_FILE)}

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @cached_property
    def data_path(self) -> Path:
        """Resolved data directory; created on first access (not at import)."""
        path = Path(self.data_dir).expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def resolved_database_url(self) -> str:
        """The database URL to actually connect to.

        Uses LINKR_DATABASE_URL when set; otherwise a SQLite file inside
        data_dir so the database sits alongside the binary blobs.
        """
        if self.database_url:
            return self.database_url
        return f"sqlite+aiosqlite:///{self.data_path / 'linkr.db'}"


settings = Settings()
