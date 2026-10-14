"""Every DuckDB that reads a database is held under a memory limit that leaves
the API room, so a heavy query spills to disk instead of getting the container
killed."""

import duckdb
import pytest

from app.config import settings
from app.services.data import db_connect


def _limit(con: duckdb.DuckDBPyConnection) -> str:
    return con.execute("SELECT current_setting('memory_limit')").fetchone()[0]


def test_the_configured_limit_applies(monkeypatch):
    monkeypatch.setattr(settings, "duckdb_memory_limit", "1GB")
    con = db_connect._open()
    try:
        assert _limit(con).replace(" ", "") in ("953.6MiB", "1.0GiB", "1GB", "953.6MB")
    finally:
        con.close()


def test_by_default_a_share_of_the_container(monkeypatch):
    monkeypatch.setattr(settings, "duckdb_memory_limit", "")
    monkeypatch.setattr(db_connect, "_container_memory", lambda: 10 * 1024**3)
    assert db_connect.memory_limit() == "6144MB"


def test_a_malformed_limit_is_refused(monkeypatch):
    monkeypatch.setattr(settings, "duckdb_memory_limit", "1GB'; SELECT 1; --")
    with pytest.raises(ValueError):
        db_connect._open()
