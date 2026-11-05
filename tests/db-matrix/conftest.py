"""The matrix imports the API's own code, so that a query takes the app's path."""

import os
import sys
import tempfile
from pathlib import Path

API = Path(os.environ["MATRIX_API_DIR"]) if "MATRIX_API_DIR" in os.environ else Path(__file__).resolve().parents[2] / "apps" / "api"
sys.path.insert(0, str(API))
sys.path.insert(0, str(Path(__file__).parent))

# The app keeps its DuckDB extensions under its data dir: point it somewhere
# disposable rather than at a developer's ~/.linkr.
os.environ.setdefault("LINKR_DATA_DIR", tempfile.mkdtemp(prefix="linkr-matrix-"))

# The server never downloads the SQL Server and Oracle extensions itself: on a
# developer's machine the matrix installs them, as an administrator would.
if {"sqlserver", "oracle"} & set(os.environ.get("MATRIX_ENGINES", "").split(",")) and "MATRIX_DUCKDB_EXT_DIR" not in os.environ:
    from app import duckdb_extensions

    duckdb_extensions.install(str(Path(os.environ["LINKR_DATA_DIR"]) / "_duckdb_ext"), community=True)
