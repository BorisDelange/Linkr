from pathlib import Path

from alembic import command
from alembic.config import Config

_API_ROOT = Path(__file__).resolve().parents[2]  # apps/api


def run_migrations() -> None:
    """Apply pending Alembic migrations (alembic upgrade head)."""
    cfg = Config(str(_API_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(_API_ROOT / "alembic"))
    command.upgrade(cfg, "head")
