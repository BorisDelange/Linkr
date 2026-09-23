"""The read-query route must not reach the server's filesystem.

It used to run `COPY (…) TO '/any/path'` and `read_csv('/etc/passwd')` as the
server's user. An agent driving the MCP relays whatever SQL it is talked into, so
the guard lives on the connection, not in a statement blacklist."""

import duckdb
import pytest

from app.services.data.db_connect import query_file, query_parquet_folder


@pytest.fixture
def source(tmp_path):
    db = tmp_path / "src.duckdb"
    con = duckdb.connect(str(db))
    con.execute("CREATE TABLE patients AS SELECT 1 AS id UNION ALL SELECT 2")
    con.close()
    return db


def _denied(run, sql):
    with pytest.raises(duckdb.Error) as exc:
        run(sql)
    assert "disabled by configuration" in str(exc.value) or "Cannot access file" in str(exc.value)


def test_database_file_reads_but_cannot_touch_files(source, tmp_path):
    run = lambda sql: query_file("duckdb", str(source), sql)  # noqa: E731
    assert run("SELECT COUNT(*) AS n FROM patients") == [{"n": 2}]
    # Temp objects still land in the in-memory catalog, which multi-statement
    # scripts rely on.
    assert run("CREATE TEMP TABLE t AS SELECT 3 AS x; SELECT x FROM t") == [{"x": 3}]

    target = tmp_path / "leak.csv"
    _denied(run, f"COPY (SELECT * FROM patients) TO '{target}'")
    assert not target.exists()
    secret = tmp_path / "secret.csv"
    secret.write_text("password\nhunter2\n")
    _denied(run, f"SELECT * FROM read_csv('{secret}')")
    _denied(run, f"ATTACH '{tmp_path / 'other.duckdb'}' AS other")
    with pytest.raises(duckdb.Error):
        run("SET enable_external_access=true")


def test_parquet_folder_reads_its_own_files_only(tmp_path):
    table = tmp_path / "patients.parquet"
    duckdb.execute(f"COPY (SELECT 1 AS id) TO '{table}' (FORMAT PARQUET)")
    other = tmp_path / "secret.parquet"
    duckdb.execute(f"COPY (SELECT 42 AS s) TO '{other}' (FORMAT PARQUET)")

    run = lambda sql: query_parquet_folder([("patients.parquet", str(table))], ["patients"], sql)  # noqa: E731
    assert run("SELECT id FROM patients") == [{"id": 1}]
    _denied(run, f"SELECT * FROM read_parquet('{other}')")
    _denied(run, f"COPY (SELECT 1) TO '{tmp_path / 'out.parquet'}' (FORMAT PARQUET)")
