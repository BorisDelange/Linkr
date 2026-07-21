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

from pathlib import Path

# Repo root: apps/api/app/export_version.py -> parents[3] == the monorepo root.
_VERSION_FILE = Path(__file__).resolve().parents[3] / "VERSION"


def _read_export_version() -> str:
    try:
        return _VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return "0.0.0"


EXPORT_APP_VERSION = _read_export_version()
