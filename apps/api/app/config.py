from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # App
    app_name: str = "LinkR"
    app_version: str = "2.0.0-dev"
    debug: bool = False
    app_mode: str = "full"  # full, dashboard, viewer

    # Database
    database_url: str = "sqlite+aiosqlite:///./linkr.db"

    # Auth
    secret_key: str = "dev-secret-change-in-production"
    access_token_expire_minutes: int = 60 * 24  # 24 hours

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


settings = Settings()
