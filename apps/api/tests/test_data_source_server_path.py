"""Tests for `serverPath` data sources — a database pointing at data already on
the server instead of uploading it. Covers how the path resolves to files (one
DuckDB/SQLite file vs a Parquet folder), the boundary re-enforced at persistence,
and the read-only guarantee (never an ETL target)."""

import pytest

from app.models.data_source import DataSource
from app.services import data_source_service, fs_browser


def _set_roots(monkeypatch, roots: str):
    from app.config import settings

    monkeypatch.setattr(settings, "fs_browse_roots", roots)


@pytest.fixture
def server_dir(tmp_path_factory):
    """A folder outside Linkr's data folder — which the tests' data_dir (tmp_path) is."""
    return tmp_path_factory.mktemp("server")


def _source(path: str | None, engine: str = "duckdb", **config) -> DataSource:
    cfg = {"engine": engine, **config}
    if path is not None:
        cfg["serverPath"] = path
    return DataSource(alias="ds", source_type="database", connection_config=cfg)


def test_server_path_reads_the_pointer():
    assert data_source_service.server_path(_source("/data/db.duckdb")) == "/data/db.duckdb"
    assert data_source_service.server_path(_source(None)) is None
    # An empty pointer is "unset", not a path to the filesystem root.
    assert data_source_service.server_path(_source("")) is None
    assert data_source_service.server_path({"serverPath": "/x"}) == "/x"


def test_single_file_resolves_to_itself(server_dir):
    f = server_dir / "warehouse.duckdb"
    f.write_text("x")
    assert data_source_service._server_path_files(str(f)) == [("warehouse.duckdb", str(f))]


def test_folder_collects_parquet_recursively(server_dir):
    (server_dir / "person").mkdir()
    (server_dir / "person" / "part-0.parquet").write_text("x")
    (server_dir / "person" / "part-1.parquet").write_text("x")
    (server_dir / "visit.parquet").write_text("x")
    (server_dir / "notes.txt").write_text("x")  # ignored

    files = data_source_service._server_path_files(str(server_dir))
    names = [n for n, _ in files]
    # Relative names, so a nested layout groups by table like an upload's
    # webkitRelativePath does.
    assert names == ["person/part-0.parquet", "person/part-1.parquet", "visit.parquet"]
    assert all(p.startswith(str(server_dir)) for _, p in files)


def test_missing_path_yields_no_files(server_dir):
    assert data_source_service._server_path_files(str(server_dir / "gone")) == []


def test_parquet_folder_is_classified_as_a_folder(server_dir):
    (server_dir / "person.parquet").write_text("x")
    files = data_source_service._server_path_files(str(server_dir))
    src = _source(str(server_dir))
    assert data_source_service._is_parquet_folder(src.connection_config, files) is True


def test_duckdb_file_is_not_classified_as_a_folder(server_dir):
    f = server_dir / "db.duckdb"
    f.write_text("x")
    files = data_source_service._server_path_files(str(f))
    src = _source(str(f))
    # A single .duckdb attaches as a file; misclassifying it would read a database
    # as Parquet and fail at query time.
    assert data_source_service._is_parquet_folder(src.connection_config, files) is False


async def test_enforce_server_path_rejects_outside_roots(db, monkeypatch, server_dir):
    allowed = server_dir / "allowed"
    allowed.mkdir()
    (allowed / "ok.duckdb").write_text("x")
    outside = server_dir / "secret.duckdb"
    outside.write_text("x")
    _set_roots(monkeypatch, str(allowed))

    await data_source_service.enforce_server_path(db, {"serverPath": str(allowed / "ok.duckdb")}, None)
    await data_source_service.enforce_server_path(db, {"engine": "duckdb"}, None)  # no pointer: fine

    # The picker's check is a convenience; a hand-made create/PATCH must still fail.
    with pytest.raises(fs_browser.FsBrowseError):
        await data_source_service.enforce_server_path(db, {"serverPath": str(outside)}, None)


def test_a_server_path_inside_linkrs_data_folder_never_attaches(tmp_path):
    # A config persisted before the rule: the tests' data_dir is tmp_path.
    db_file = tmp_path / "linkr.db"
    db_file.write_text("x")
    (tmp_path / "t.parquet").write_text("x")
    assert data_source_service._server_path_files(str(db_file)) == []
    assert data_source_service._server_path_files(str(tmp_path)) == []
    assert data_source_service._server_path_files(str(tmp_path.parent)) == []


def test_a_parquet_folder_skips_symlinks_into_linkrs_data_folder(tmp_path, server_dir):
    (tmp_path / "secret.parquet").write_text("x")
    (server_dir / "person.parquet").write_text("x")
    (server_dir / "leak.parquet").symlink_to(tmp_path / "secret.parquet")
    assert [n for n, _ in data_source_service._server_path_files(str(server_dir))] == ["person.parquet"]


def test_server_path_source_is_never_managed(server_dir):
    # `run_etl_sql` refuses any target that is not managed, which is what keeps a
    # server path read-only: Linkr does not own that file and must never write it.
    f = server_dir / "db.duckdb"
    f.write_text("x")
    assert data_source_service.is_managed(_source(str(f))) is False
