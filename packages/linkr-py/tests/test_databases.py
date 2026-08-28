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
