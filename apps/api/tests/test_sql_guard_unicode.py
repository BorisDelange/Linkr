"""The SQL checks read the statement DuckDB's parser runs, whatever characters it
holds: a multi-byte character anywhere, or a code point the parser takes for blank
space, leaves every check as strict as on an ASCII statement."""

import sqlite3
import unicodedata

import duckdb
import pytest

from app.services.data import connection_pool, db_connect
from app.services.data.db_connect import (
    _reject_copy_to_file,
    _reject_forbidden_statements,
    _reject_session_statements,
    _token_texts,
    _tokens,
    query_file,
    query_parquet_folder,
    run_etl_sql,
)

# The code points DuckDB 1.5's parser skips as blank space.
_BLANK = (
    "\u00a0\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u200b\u202f\u205f\u2060\u3000\ufeff"
)


def _sqlite_file(path, table: str, value: str) -> str:
    con = sqlite3.connect(path)
    con.execute(f"CREATE TABLE {table}(a TEXT)")
    con.execute(f"INSERT INTO {table} VALUES (?)", (value,))
    con.commit()
    con.close()
    return str(path)


@pytest.fixture
def two_sqlite_files(tmp_path):
    return (
        _sqlite_file(tmp_path / "own.sqlite", "mine", "own-row"),
        _sqlite_file(tmp_path / "other.sqlite", "theirs", "other-file-row"),
    )


@pytest.fixture
def parquet_table(tmp_path):
    table = tmp_path / "blobs" / "abc123"
    table.parent.mkdir()
    duckdb.execute(f"COPY (SELECT 1 AS id UNION ALL SELECT 2) TO '{table}' (FORMAT PARQUET)")
    return table


def _ids(table) -> list[tuple]:
    return duckdb.execute(f"SELECT id FROM read_parquet('{table}') ORDER BY id").fetchall()


def test_token_offsets_index_the_statement_by_character():
    stmt = "SELECT 'é€😀' AS m FROM sqlite_scan('x', 'y')"
    texts = [t for t, _ in _token_texts(stmt)]
    assert "SQLITE_SCAN" in texts
    assert texts[texts.index("SQLITE_SCAN") + 1] == "("
    for pos, _ in _tokens(stmt):
        assert not stmt[pos].isspace()


def test_the_parser_reads_exactly_these_code_points_as_blank_space():
    con = duckdb.connect()
    candidates = [
        chr(cp) for cp in range(0x80, 0x10000)
        if not 0xD800 <= cp <= 0xDFFF and unicodedata.category(chr(cp))[0] in "ZC"
        and unicodedata.category(chr(cp)) not in ("Co", "Cn")
    ]
    blank = set()
    for ch in candidates:
        try:
            if con.execute(f"SELECT{ch}42{ch}AS{ch}x").fetchall() == [(42,)]:
                blank.add(ch)
        except duckdb.Error:
            pass
    assert blank == set(_BLANK) == set(db_connect._PARSER_SPACE_CHARS)


_PREFIXES = ["/* é */ ", "SELECT 'é' AS m; ", "-- é€😀\n"]


@pytest.mark.parametrize("template", [
    "{p}SELECT * FROM sqlite_scan('{other}', 'theirs')",
    "SELECT 'é' AS m, a FROM sqlite_scan('{other}', 'theirs')",
    "{p}CALL sqlite_attach('{other}')",
    *[f"SELECT * FROM sqlite_scan{ch}('{{other}}', 'theirs')" for ch in _BLANK],
    *[f"SELECT * FROM{ch}sqlite_scan('{{other}}', 'theirs')" for ch in _BLANK],
])
@pytest.mark.parametrize("p", _PREFIXES)
def test_a_sqlite_database_reads_only_itself_whatever_the_characters(two_sqlite_files, template, p):
    own, other = two_sqlite_files
    with pytest.raises(ValueError, match="not allowed"):
        query_file("sqlite", own, template.format(other=other, p=p))


def test_a_pooled_sqlite_connection_keeps_only_its_own_database(two_sqlite_files):
    own, other = two_sqlite_files
    key = "unicode-guard-pool"
    try:
        with pytest.raises(ValueError, match="not allowed"):
            query_file("sqlite", own, f"/* é */ CALL sqlite_attach('{other}')", pool_key=key)
        assert query_file("sqlite", own, "SELECT a FROM mine", pool_key=key) == [{"a": "own-row"}]
    finally:
        connection_pool.invalidate(key)


@pytest.mark.parametrize("sql", [
    "EXPLAIN /*éééééééééé*/ ANALYZE/* SELECT 1 --*/ COPY (SELECT 888 AS id) TO '{t}' (FORMAT PARQUET, USE_TMP_FILE FALSE)",
    "EXPLAIN\u00a0ANALYZE COPY (SELECT 888 AS id) TO '{t}' (FORMAT PARQUET, USE_TMP_FILE FALSE)",
    "\u200bCOPY (SELECT 888 AS id) TO '{t}' (FORMAT PARQUET, USE_TMP_FILE FALSE)",
    "COPY (SELECT 666 AS id, 'é' AS m) TO '{t}' (FORMAT PARQUET, USE_TMP_FILE FALSE);SELECT 1 AS ok",
])
def test_a_parquet_source_query_never_writes_its_files(parquet_table, sql):
    run = lambda q: query_parquet_folder([("patients.parquet", str(parquet_table))], ["patients"], q)
    with pytest.raises((ValueError, duckdb.Error)):
        run(sql.format(t=parquet_table))
    assert _ids(parquet_table) == [(1,), (2,)]


@pytest.mark.parametrize("sql", [
    "COPY (SELECT 666 AS id, 'é' AS m) TO '{t}' (FORMAT PARQUET, USE_TMP_FILE FALSE)",
    "/* é */ COPY (SELECT 666 AS id) TO '{t}' (FORMAT PARQUET, USE_TMP_FILE FALSE)",
    "COPY\u2003(SELECT 666 AS id) TO '{t}' (FORMAT PARQUET, USE_TMP_FILE FALSE)",
    "COPY (SELECT 666 AS id)\u200bTO '{t}' (FORMAT PARQUET, USE_TMP_FILE FALSE)",
    "EXPLAIN /*éééééééééé*/ ANALYZE/* SELECT 1 --*/ COPY (SELECT 666 AS id) TO '{t}' (FORMAT PARQUET, USE_TMP_FILE FALSE)",
])
def test_a_pipeline_script_never_writes_its_inputs_whatever_the_characters(tmp_path, parquet_table, sql):
    target = tmp_path / "target.duckdb"
    duckdb.connect(str(target)).close()
    role = {"kind": "parquet", "files": [("patients.parquet", str(parquet_table))], "known": ["patients"]}
    with pytest.raises((ValueError, duckdb.Error)):
        run_etl_sql(str(target), sql.format(t=parquet_table), {"source": role})
    assert _ids(parquet_table) == [(1,), (2,)]


@pytest.mark.parametrize("sql", [
    "/* é */ SELECT * FROM postgres_scan('host=elsewhere dbname=x', 'public', 't')",
    "SELECT 'é' AS m FROM postgres_execute('ext', 'DROP TABLE t')",
    "SELECT * FROM postgres_scan\u200b('host=elsewhere dbname=x', 'public', 't')",
    "/* é */ CALL enable_logging()",
    "/* é */ SELECT * FROM query('SELECT * FROM sqlite_scan(''x'', ''y'')')",
])
def test_user_sql_opens_nothing_of_its_own_whatever_the_characters(sql):
    with pytest.raises(ValueError, match="not allowed"):
        _reject_session_statements(sql)
    with pytest.raises(ValueError, match="not allowed"):
        _reject_forbidden_statements(sql)


@pytest.mark.parametrize("sql", [
    "/* é */ INSTALL httpfs",
    "\u200bINSTALL httpfs",
    "FORCE\u00a0INSTALL httpfs",
    "\ufeffATTACH 'x.duckdb' AS y",
])
def test_extension_and_attach_statements_are_refused_whatever_the_characters(sql):
    with pytest.raises(ValueError, match="not allowed"):
        _reject_forbidden_statements(sql)
    with pytest.raises(ValueError, match="not allowed"):
        _reject_session_statements(sql)


@pytest.mark.parametrize("sql", [
    "COPY t\u00a0TO 'x'",
    "/* é */ COPY t TO 'x'",
    "COPY (SELECT 'é') TO 'x'",
])
def test_copy_direction_is_read_on_the_parsed_text(sql):
    assert db_connect._copies_to_a_file(db_connect._strip_leading_noise(sql)) is True
    with pytest.raises(ValueError):
        _reject_copy_to_file(sql)


@pytest.mark.parametrize("sql", [
    "SELECT 'é€😀' AS m, a FROM mine",
    "/* commentaire : données */ SELECT a AS \"donnée\" FROM mine",
    "SELECT a FROM mine WHERE a <> 'sqlite_scan(é)'",
    "SELECT 'a\u00a0b' AS m",
])
def test_legitimate_statements_with_any_characters_still_run(two_sqlite_files, sql):
    own, _ = two_sqlite_files
    assert len(query_file("sqlite", own, sql)) == 1


def test_the_statement_run_keeps_the_characters_of_its_literals():
    sql = "SELECT 'a\u00a0b\u200bc' AS m"
    assert db_connect._statements_to_run(duckdb.connect(), sql) == [sql]
