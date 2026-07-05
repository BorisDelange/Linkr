from functools import cached_property
from pathlib import Path

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

    # Code execution
    enable_code_execution: bool = True
    max_sessions_per_user: int = 5
    session_timeout_minutes: int = 60

    # Features
    enable_git: bool = True
    enable_mlops: bool = False
    enable_ai_assistant: bool = False

    # Languages
    available_languages: list[str] = ["en", "fr"]
    default_language: str = "en"

    # Data
    data_dir: str = "~/.linkr"

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
