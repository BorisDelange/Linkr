"""Each DuckDB db_connect._open() creates is held under a memory limit that leaves
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


def test_a_malformed_setting_stops_the_startup():
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError, match="LINKR_DUCKDB_MEMORY_LIMIT"):
        Settings(duckdb_memory_limit="3 gigs")
    assert Settings(duckdb_memory_limit=" 512MiB ").duckdb_memory_limit == "512MiB"


_RAM = 16 * 1024**3


@pytest.fixture
def ram(monkeypatch):
    monkeypatch.setattr(db_connect, "_physical_memory", lambda: _RAM)


def _cgroup(tmp_path, value: str) -> tuple[str, ...]:
    path = tmp_path / "memory.max"
    path.write_text(value + "\n")
    return (str(path),)


def test_a_cgroup_cap_is_the_memory(tmp_path, ram):
    assert db_connect._container_memory(_cgroup(tmp_path, str(4 * 1024**3))) == 4 * 1024**3


@pytest.mark.parametrize("value", ["max", "9223372036854771712", str(_RAM * 2)])
def test_an_unlimited_cgroup_reads_as_the_ram(tmp_path, ram, value):
    """v2 writes "max", v1 a page-rounded 2^63: neither caps anything."""
    assert db_connect._container_memory(_cgroup(tmp_path, value)) == _RAM


def test_without_a_cgroup_the_ram(tmp_path, ram):
    assert db_connect._container_memory((str(tmp_path / "absent"),)) == _RAM


def test_the_v1_file_is_read_when_v2_is_absent(tmp_path, ram):
    v1 = tmp_path / "memory.limit_in_bytes"
    v1.write_text(str(2 * 1024**3))
    assert db_connect._container_memory((str(tmp_path / "absent"), str(v1))) == 2 * 1024**3
