"""Export-format version stamped into exported entities (e.g. project.json's
``appVersion``).

This is NOT the server/deployment version (that is ``config.app_version``, shown
in logs, /health and the OpenAPI title). It is the *content* version written into
exports, and it MUST equal the frontend's value: both read the SAME repo-root
``VERSION`` file (the frontend via vite.config.ts ``__APP_VERSION__``), so a
front-only client and a server client versioning the same repo write an identical
``appVersion`` and don't fabricate false git diffs. The project-export golden
tests pin it, so a drift fails CI rather than shipping silently.
"""

import os
from pathlib import Path


def _find_version_file() -> Path | None:
    # Dev: apps/api/app/ -> repo root is 3 levels up. Docker: the api app is
    # copied to /app/app/ (no repo root above), so walk up and take the first
    # VERSION found; LINKR_VERSION_FILE overrides (the Dockerfile sets it).
    override = os.environ.get("LINKR_VERSION_FILE")
    if override:
        return Path(override)
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "VERSION"
        if candidate.is_file():
            return candidate
    return None


def _read_export_version() -> str:
    version_file = _find_version_file()
    if version_file is None:
        return "0.0.0"
    try:
        return version_file.read_text(encoding="utf-8").strip()
    except OSError:
        return "0.0.0"


EXPORT_APP_VERSION = _read_export_version()
