from fastapi import APIRouter

from app.config import settings
from app.core import example_secret

router = APIRouter()


@router.get("/health")
async def health_check():
    # 200 even while the instance refuses (core/example_secret.py): the process is up,
    # and a monitor or the web app reads why from `refusal`.
    refusing = example_secret.refusing()
    return {
        "status": "refusing" if refusing else "ok",
        "app": settings.app_name,
        "version": settings.app_version,
        **({"refusal": example_secret.refusal()} if refusing else {}),
    }
