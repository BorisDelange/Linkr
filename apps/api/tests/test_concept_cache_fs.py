"""The concept-list Parquet cache: materialize a real source to Parquet, page it
back, and check atomic replace + invalidation."""

import duckdb
import pytest

from app.services.data import concept_cache_fs


@pytest.fixture
def duckdb_source(tmp_path):
    """A tiny DuckDB file with a `concept` table, returned as the (config, files)
    a file-engine source would pass to materialize."""
    db = tmp_path / "src.duckdb"
    con = duckdb.connect(str(db))
    con.execute("CREATE TABLE concept (concept_id INTEGER, concept_name TEXT, record_count INTEGER)")
    con.execute("INSERT INTO concept VALUES (1,'Sodium',10),(2,'Glucose',20),(3,'Urea',0)")
    con.close()
    config = {"engine": "duckdb"}
    files = [("src.duckdb", str(db))]
    return config, files


def test_refresh_materializes_and_page_reads_back(duckdb_source, monkeypatch, tmp_path):
    from app.config import settings
    monkeypatch.setattr(settings, "data_dir", str(tmp_path / "data"), raising=False)
    # data_path is a cached_property; clear it so the temp dir takes effect.
    settings.__dict__.pop("data_path", None)

    config, files = duckdb_source
    src_id = "src-abc"
    select = "SELECT concept_id, concept_name, record_count FROM ext.concept"

    assert not concept_cache_fs.exists(src_id)
    concept_cache_fs.refresh(config, None, files, [], select, src_id)
    assert concept_cache_fs.exists(src_id)

    # Page query runs against the cached Parquet (view `concepts`), never the source.
    rows = concept_cache_fs.query_page(
        src_id, "SELECT * FROM concepts ORDER BY record_count DESC LIMIT 2"
    )
    assert [r["concept_id"] for r in rows] == [2, 1]
    assert rows[0]["concept_name"] == "Glucose"

    settings.__dict__.pop("data_path", None)


def test_invalidate_removes_cache(duckdb_source, monkeypatch, tmp_path):
    from app.config import settings
    monkeypatch.setattr(settings, "data_dir", str(tmp_path / "data2"), raising=False)
    settings.__dict__.pop("data_path", None)

    config, files = duckdb_source
    src_id = "src-xyz"
    concept_cache_fs.refresh(
        config, None, files, [], "SELECT concept_id, concept_name FROM ext.concept", src_id
    )
    assert concept_cache_fs.exists(src_id)
    concept_cache_fs.invalidate(src_id)
    assert not concept_cache_fs.exists(src_id)
    with pytest.raises(FileNotFoundError):
        concept_cache_fs.query_page(src_id, "SELECT * FROM concepts")

    settings.__dict__.pop("data_path", None)


def test_cache_path_rejects_bad_id():
    with pytest.raises(ValueError):
        concept_cache_fs.cache_path("../etc/passwd")
