import os
import subprocess
import sys
from pathlib import Path

import pytest

from linkr import _databases
from linkr._api import LinkrError

CONNECTABLE = [{"id": "x", "name": "Db", "dialect": "duckdb", "kind": "managed",
                "connectable": True, "path": "/tmp/x.duckdb"}]


def test_quote_doubles_embedded_quotes():
    # A DSN carries a password, which may legitimately contain a quote; it must
    # not be able to close the SQL literal it is interpolated into.
    assert _databases._quote("o'brien") == "'o''brien'"
    assert _databases._quote("plain") == "'plain'"


def test_unconnectable_source_says_why(monkeypatch):
    rows = [{**CONNECTABLE[0], "connectable": False}]
    monkeypatch.setattr(_databases, "api_call", lambda path: rows)

    with pytest.raises(LinkrError, match="no data has been uploaded"):
        _databases.connect("Db")


def test_unknown_dialect_is_refused_rather_than_guessed(monkeypatch):
    # An engine DuckDB cannot attach (Oracle) must fail clearly, not be opened as
    # if it spoke DuckDB.
    rows = [{**CONNECTABLE[0], "dialect": "oracle"}]
    monkeypatch.setattr(_databases, "api_call", lambda path: rows)

    with pytest.raises(LinkrError, match="oracle"):
        _databases.connect("Db")


def test_empty_name_is_rejected():
    with pytest.raises(LinkrError, match="name"):
        _databases.connect("")


def test_package_imports_without_duckdb_installed():
    # `import linkr` must work in a project environment that declares nothing: the
    # path helpers need no dependency at all. A top-level `import duckdb` made the
    # whole package unimportable there, so even linkr.scripts_dir() failed. Run in a
    # subprocess with duckdb blocked, since it is already imported in this one.
    src = str(Path(__file__).resolve().parents[1] / "src")
    # A meta_path finder that refuses duckdb reproduces an environment where it was
    # never installed, without needing a throwaway venv.
    code = (
        "import sys\n"
        "class Block:\n"
        "    def find_spec(self, name, path=None, target=None):\n"
        "        if name == 'duckdb':\n"
        "            raise ModuleNotFoundError(\"No module named 'duckdb'\")\n"
        "sys.meta_path.insert(0, Block())\n"
        "import linkr\n"
        "print(linkr.scripts_dir())\n"
    )
    res = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True, text=True,
        env={**os.environ, "PYTHONPATH": src, "LINKR_SCRIPTS": "/srv/code"},
    )
    assert res.returncode == 0, res.stderr
    assert res.stdout.strip() == "/srv/code"


def test_duckdb_is_resolved_at_call_time_not_import_time(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_duckdb(name, *args, **kwargs):
        if name == "duckdb":
            raise ModuleNotFoundError("No module named 'duckdb'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_duckdb)

    # Missing duckdb surfaces as an actionable LinkrError naming the package to
    # install, not a bare ModuleNotFoundError from inside the package.
    with pytest.raises(LinkrError, match="duckdb"):
        _databases._duckdb()


def test_databases_shape(monkeypatch):
    monkeypatch.setattr(
        _databases, "api_call",
        lambda path: [{"id": "a", "name": "N", "engine": "duckdb",
                       "dialect": "duckdb", "kind": "managed", "connectable": True}],
    )

    assert _databases.databases() == [
        {"id": "a", "name": "N", "engine": "duckdb", "dialect": "duckdb",
         "kind": "managed", "connectable": True}
    ]
