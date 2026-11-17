"""The programs Linkr runs to build project environments, checked at boot so a
missing one is named in the log before a user meets it as a failed build."""

import shutil
from pathlib import Path

from app.config import settings
from app.services.execution.renv_provisioner import R_MISSING_HINT
from app.services.execution.uv_provisioner import UV_MISSING_HINT, uv_bin


def _found(program: str) -> bool:
    return shutil.which(program) is not None or Path(program).is_file()


def missing() -> dict[str, str]:
    """Each missing program and what to do. R is optional (Python-only instances run
    without it); uv is not, for any instance that runs code."""
    gaps: dict[str, str] = {}
    if not _found(uv_bin()):
        gaps["uv"] = UV_MISSING_HINT
    if not _found(settings.rscript_bin):
        gaps["Rscript"] = R_MISSING_HINT
    return gaps
