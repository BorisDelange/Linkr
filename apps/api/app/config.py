from functools import cached_property
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # App
    app_name: str = "Linkr"
    app_version: str = "2.0.0-dev"
    debug: bool = False
    app_mode: str = "full"  # full, dashboard, viewer

    # Database
    database_url: str = "sqlite+aiosqlite:///./linkr.db"

    # Auth
    secret_key: str = "dev-secret-change-in-production"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24  # 24 hours
    refresh_token_expire_days: int = 30
    auth_provider: str = "local"  # local, ldap, oidc, saml (only local implemented)

    # CORS
    cors_origins: list[str] = ["http://localhost:3000"]

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

    model_config = {"env_prefix": "LINKR_", "env_file": ".env"}

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_cors(cls, v):
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @cached_property
    def data_path(self) -> Path:
        """Resolved data directory; created on first access (not at import)."""
        path = Path(self.data_dir).expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path


settings = Settings()
