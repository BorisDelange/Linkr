"""A data dir whose path holds a quote: every DuckDB statement that names a file
under it (extension directory, COPY targets, readers) still parses."""

from datetime import date, timedelta

import pytest

from app.config import settings
from app.core import audit
from app.services import vocabulary_library
from app.services.data import global_table_service, scores_service


@pytest.fixture(autouse=True)
def _quoted_data_dir(tmp_path, monkeypatch):
    quoted = tmp_path / "l'entrepôt"
    quoted.mkdir()
    monkeypatch.setattr(settings, "data_dir", str(quoted))
    settings.__dict__.pop("data_path", None)
    audit.reset()
    yield quoted
    settings.__dict__.pop("data_path", None)
    audit.reset()


def test_audit_compacts_appends_and_exports_under_a_quoted_dir(_quoted_data_dir):
    today = date.today()
    for offset in (2, 1):
        audit.write({"user_id": 1, "username": "a", "action": "query"})
        [path] = sorted((settings.data_path / "audit").glob("*.jsonl"))
        path.rename(path.with_name(f"{(today - timedelta(days=offset)).isoformat()}.jsonl"))
        audit.compact(today)
    out = _quoted_data_dir / "it's.csv"
    assert audit.export_csv(out) == 2
    assert audit.verify()["ok"] is True


def test_duckdb_connections_set_their_extension_directory_under_a_quoted_dir():
    scores_service._connect().close()
    vocabulary_library._connect().close()


def test_global_table_cache_is_written_under_a_quoted_dir(_quoted_data_dir):
    dest = _quoted_data_dir / "cache" / "ws__flat__0123456789abcdef.parquet"
    global_table_service.materialize([], "flat", dest)
    assert dest.is_file()
    assert global_table_service.query_page(dest, "flat", {}, None, 10, 0) == ([], 0)
