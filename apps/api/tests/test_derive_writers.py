"""The derivation writers, offline: Doris' Stream Load (its redirects checked, the
file sent once), the Doris and Oracle column types, and SQL Server's T-SQL delete."""

import duckdb
import httpx
import pytest

from app.config import settings
from app.services.data import derive_writers
from app.services.data.db_host_guard import DbHostNotAllowed

DORIS = {"engine": "doris", "host": "doris-fe.internal", "httpPort": 8030, "username": "writer"}


def _doris(config: dict) -> derive_writers.DorisWriter:
    writer = object.__new__(derive_writers.DorisWriter)
    writer.config = config
    writer.password = "pw"
    return writer


@pytest.fixture
def stream_load(monkeypatch, tmp_path):
    """Runs a Stream Load against `answer(request)`, returning the requests made."""
    monkeypatch.setattr(settings, "db_allowed_hosts", "doris-fe.internal,10.0.0.0/8")
    parquet = tmp_path / "rows.parquet"
    parquet.write_bytes(b"PAR1" + b"x" * 3000 + b"PAR1")

    def run(answer, config=DORIS):
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            request.read()
            requests.append(request)
            return answer(request)

        real = httpx.Client
        monkeypatch.setattr(httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
        try:
            return _doris(config)._stream_load("cohort", "person", parquet), requests
        finally:
            monkeypatch.setattr(httpx, "Client", real)

    return run


def _loaded(rows: int = 7) -> httpx.Response:
    return httpx.Response(200, json={"Status": "Success", "NumberLoadedRows": rows})


def test_a_redirect_to_a_backend_is_followed_and_the_file_sent_once(stream_load):
    def answer(request):
        if request.url.host == "doris-fe.internal":
            return httpx.Response(307, headers={"location": "http://10.0.0.7:8040/api/cohort/person/_stream_load"})
        return _loaded()

    loaded, requests = stream_load(answer)
    assert loaded == 7
    # No empty PUT reaches the backend: it would run as a load of its own.
    assert [(r.url.host, len(r.content)) for r in requests] == [("doris-fe.internal", 0), ("10.0.0.7", 3008)]
    assert all(r.headers["authorization"].startswith("Basic ") for r in requests)
    assert requests[-1].headers["content-length"] == "3008"


def test_a_relative_location_is_resolved_against_the_frontend(stream_load):
    def answer(request):
        if request.url.path.startswith("/api/"):
            return httpx.Response(307, headers={"location": "/be/cohort/person/_stream_load"})
        return _loaded(3)

    loaded, requests = stream_load(answer)
    assert loaded == 3
    assert str(requests[-1].url) == "http://doris-fe.internal:8030/be/cohort/person/_stream_load"


def test_a_redirect_outside_the_allowlist_is_refused(stream_load):
    def answer(request):
        return httpx.Response(307, headers={"location": "http://203.0.113.5:8040/api/cohort/person/_stream_load"})

    with pytest.raises(DbHostNotAllowed):
        stream_load(answer)


def test_a_redirect_without_location_is_refused(stream_load):
    with pytest.raises(ValueError, match="without a Location"):
        stream_load(lambda request: httpx.Response(307))


def test_https_is_used_when_asked_and_never_downgraded(stream_load):
    def answer(request):
        if request.url.scheme == "https" and request.url.host == "doris-fe.internal":
            return httpx.Response(307, headers={"location": "http://10.0.0.7:8040/x"})
        return _loaded()

    with pytest.raises(ValueError, match="https to http"):
        stream_load(answer, {**DORIS, "httpTls": True})
    loaded, requests = stream_load(lambda request: _loaded(2), {**DORIS, "httpTls": True})
    assert loaded == 2 and requests[0].url.scheme == "https"


def test_a_failed_load_reports_doris_message(stream_load):
    with pytest.raises(ValueError, match="too many filtered rows"):
        stream_load(lambda request: httpx.Response(200, json={"Status": "Fail", "Message": "too many filtered rows"}))


@pytest.mark.parametrize("duck, doris", [
    ("INTEGER", "INT"), ("BIGINT", "BIGINT"), ("HUGEINT", "LARGEINT"), ("UBIGINT", "LARGEINT"),
    ("DECIMAL(18,3)", "DECIMAL(18,3)"), ("decimal(5,2)", "DECIMAL(5,2)"), ("TIMESTAMP", "DATETIME(6)"),
    ("TIMESTAMP_S", "DATETIME"), ("DATE", "DATE"), ("BOOLEAN", "BOOLEAN"), ("VARCHAR", "STRING"),
    ("INTEGER[]", "STRING"), ("UUID", "STRING"),
])
def test_doris_types(duck, doris):
    assert derive_writers._doris_type(duck) == doris


def _oracle_writer() -> derive_writers.OracleWriter:
    writer = object.__new__(derive_writers.OracleWriter)
    writer.con = duckdb.connect()
    return writer


def test_oracle_columns_size_text_by_its_longest_value():
    writer = _oracle_writer()
    select = (
        "SELECT 1::BIGINT AS id, 'short' AS code, repeat('x', 1500) AS note, 2.5::DECIMAL(9,2) AS dose, "
        "true AS flag, DATE '2020-01-01' AS d, [1, 2] AS ids"
    )
    assert writer._columns(select) == [
        ("id", "BIGINT", "NUMBER(19)"),
        ("code", "VARCHAR", "VARCHAR2(1000 CHAR)"),
        ("note", "VARCHAR", "CLOB"),
        ("dose", "DECIMAL(9,2)", "NUMBER(9,2)"),
        ("flag", "BOOLEAN", "NUMBER(1)"),
        ("d", "DATE", "DATE"),
        ("ids", "INTEGER[]", "CLOB"),
    ]


def test_oracle_cast_turns_booleans_to_numbers_and_the_rest_to_text():
    writer = _oracle_writer()
    columns = writer._columns("SELECT true AS flag, [1, 2] AS ids, repeat('x', 1500) AS note, 1 AS n")
    sql = writer._cast(columns, "SELECT 1")
    assert sql == (
        'SELECT CAST("flag" AS TINYINT) AS "flag", CAST("ids" AS VARCHAR) AS "ids", "note", "n" FROM (SELECT 1)'
    )


class _Recorder:
    def __init__(self):
        self.calls: list[tuple[str, list]] = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return self


def test_sqlserver_delete_where_sends_tsql_with_a_literal():
    con = _Recorder()
    derive_writers.SqlServerWriter(con, "dst").delete_where("linkr", "pseudonyms", "source_id", "o'brien")
    assert con.calls == [(
        "SELECT mssql_exec(?, ?)",
        ["dst", "DELETE FROM [linkr].[pseudonyms] WHERE [source_id] = N'o''brien'"],
    )]


def test_sqlserver_delete_where_refuses_a_name_that_is_not_an_identifier():
    with pytest.raises(ValueError):
        derive_writers.SqlServerWriter(_Recorder(), "dst").delete_where("linkr]; DROP TABLE x;--", "t", "c", "v")


def test_oracle_writer_checks_every_column_name_before_any_statement():
    writer = _oracle_writer()

    class Cursor:
        statements: list[str] = []

        def execute(self, sql, **_):
            self.statements.append(sql)

    writer.cur = Cursor()
    select = 'SELECT 1::BIGINT AS "a"" NUMBER, b", \'x\' AS code'
    with pytest.raises(ValueError, match="invalid column name"):
        writer.create_table_as("cohort", "person", select)
    with pytest.raises(ValueError, match="invalid column name"):
        writer._columns(select)
    assert Cursor.statements == []
