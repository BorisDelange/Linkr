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
