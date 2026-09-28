"""The read-query route must not reach the server's filesystem.

It used to run `COPY (…) TO '/any/path'` and `read_csv('/etc/passwd')` as the
server's user. An agent driving the MCP relays whatever SQL it is talked into, so
the guard lives on the connection, not in a statement blacklist."""

import duckdb
import pytest

from app.services.data import connection_pool
from app.services.data.db_connect import (
    materialize_parquet,
    query_cached_parquet,
    query_file,
    query_file_source,
    query_parquet_folder,
)


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


def _refused(run, sql):
    with pytest.raises(ValueError, match="COPY is not allowed"):
        run(sql)


def test_database_file_reads_but_cannot_touch_files(source, tmp_path):
    run = lambda sql: query_file("duckdb", str(source), sql)  # noqa: E731
    assert run("SELECT COUNT(*) AS n FROM patients") == [{"n": 2}]
    # Temp objects still land in the in-memory catalog, which multi-statement
    # scripts rely on.
    assert run("CREATE TEMP TABLE t AS SELECT 3 AS x; SELECT x FROM t") == [{"x": 3}]

    target = tmp_path / "leak.csv"
    _refused(run, f"COPY (SELECT * FROM patients) TO '{target}'")
    assert not target.exists()
    secret = tmp_path / "secret.csv"
    secret.write_text("password\nhunter2\n")
    _denied(run, f"SELECT * FROM read_csv('{secret}')")
    with pytest.raises(ValueError):
        run(f"ATTACH '{tmp_path / 'other.duckdb'}' AS other")
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
    _refused(run, f"COPY (SELECT 1) TO '{tmp_path / 'out.parquet'}' (FORMAT PARQUET)")


def test_concept_cache_page_reads_only_its_cache(tmp_path):
    cache = tmp_path / "cache.parquet"
    duckdb.execute(f"COPY (SELECT 7 AS concept_id) TO '{cache}' (FORMAT PARQUET)")
    secret = tmp_path / "secret.txt"
    secret.write_text("hunter2")

    run = lambda sql: query_cached_parquet(str(cache), sql)  # noqa: E731
    assert run("SELECT concept_id FROM concepts") == [{"concept_id": 7}]
    _denied(run, f"SELECT * FROM read_text('{secret}')")
    _refused(run, f"COPY (SELECT 1) TO '{tmp_path / 'out.csv'}'")
    assert not (tmp_path / "out.csv").exists()


def test_concept_cache_refresh_writes_only_its_cache(source, tmp_path):
    config, files = {"engine": "duckdb"}, [("src.duckdb", str(source))]
    dest = tmp_path / "cache" / "c.parquet"
    materialize_parquet(config, None, files, [], "SELECT id FROM patients", str(dest))
    assert duckdb.execute(f"SELECT COUNT(*) FROM '{dest}'").fetchone()[0] == 2

    evil = tmp_path / "evil.csv"
    smuggled = f"SELECT 1 AS x) TO '{evil}' (FORMAT CSV); COPY (SELECT 1"
    with pytest.raises((ValueError, duckdb.Error)):
        materialize_parquet(config, None, files, [], smuggled, str(dest))
    assert not evil.exists()
    secret = tmp_path / "secret.txt"
    secret.write_text("hunter2")
    with pytest.raises(duckdb.Error):
        materialize_parquet(config, None, files, [], f"SELECT * FROM read_text('{secret}')", str(dest))


def test_concept_cache_refresh_of_a_parquet_folder_still_reads_its_files(tmp_path):
    table = tmp_path / "patients.parquet"
    duckdb.execute(f"COPY (SELECT 1 AS id) TO '{table}' (FORMAT PARQUET)")
    dest = tmp_path / "c.parquet"
    materialize_parquet(
        {"engine": "duckdb"}, None, [("patients.parquet", str(table))], ["patients"],
        "SELECT id FROM patients", str(dest),
    )
    assert duckdb.execute(f"SELECT id FROM '{dest}'").fetchall() == [(1,)]


def _in_place_overwrite(target) -> str:
    """The write-back `allowed_paths` lets through: DuckDB grants the listed files
    write access too, and USE_TMP_FILE FALSE skips the tmp_ sibling that a plain
    COPY would be refused on."""
    return f"COPY (SELECT 99 AS id) TO '{target}' (FORMAT PARQUET, USE_TMP_FILE FALSE)"


def _ids(path) -> list[tuple]:
    return duckdb.execute(f"SELECT * FROM read_parquet('{path}')").fetchall()


def test_parquet_folder_cannot_overwrite_its_own_files(tmp_path):
    table = tmp_path / "patients.parquet"
    duckdb.execute(f"COPY (SELECT 1 AS id) TO '{table}' (FORMAT PARQUET)")
    for pool_key in (None, "test-overwrite-parquet-source"):
        try:
            with pytest.raises(ValueError):
                query_parquet_folder(
                    [("patients.parquet", str(table))], ["patients"],
                    _in_place_overwrite(table), pool_key=pool_key,
                )
        finally:
            if pool_key:
                connection_pool.invalidate(pool_key)
    assert _ids(table) == [(1,)]


def test_concept_cache_page_cannot_overwrite_the_cache(tmp_path):
    cache = tmp_path / "cache.parquet"
    duckdb.execute(f"COPY (SELECT 7 AS id) TO '{cache}' (FORMAT PARQUET)")
    for sql in (_in_place_overwrite(cache), f"SELECT 1; /* x */ {_in_place_overwrite(cache)}"):
        with pytest.raises(ValueError):
            query_cached_parquet(str(cache), sql)
    assert _ids(cache) == [(7,)]


def test_mapping_file_source_cannot_overwrite_its_blob(tmp_path):
    blob = tmp_path / "blob.parquet"
    duckdb.execute(
        f"COPY (SELECT 1 AS concept_id, 'A' AS concept_code, 'LOCAL' AS vocabulary_id) "
        f"TO '{blob}' (FORMAT PARQUET)"
    )
    with pytest.raises(ValueError):
        query_file_source(
            str(blob), "concepts.parquet", {}, _SELECT, "vocabulary_id, concept_code",
            _in_place_overwrite(blob),
        )
    assert _ids(blob) == [(1, "A", "LOCAL")]


@pytest.mark.parametrize("select_sql", [
    "SELECT id FROM patients; {overwrite}",
    "SELECT id FROM patients) TO '{target}' (FORMAT PARQUET, USE_TMP_FILE FALSE) --",
    "{overwrite}",
])
def test_concept_cache_refresh_cannot_overwrite_the_source(tmp_path, select_sql):
    table = tmp_path / "patients.parquet"
    duckdb.execute(f"COPY (SELECT 1 AS id) TO '{table}' (FORMAT PARQUET)")
    sql = select_sql.format(overwrite=_in_place_overwrite(table), target=table)
    with pytest.raises((ValueError, duckdb.Error)):
        materialize_parquet(
            {"engine": "duckdb"}, None, [("patients.parquet", str(table))], ["patients"],
            sql, str(tmp_path / "c.parquet"),
        )
    assert _ids(table) == [(1,)]


_SELECT = "concept_id::INTEGER AS concept_id, concept_code, vocabulary_id"


@pytest.mark.parametrize("encoding", [None, "Windows-1252"])
def test_mapping_file_source_reads_only_its_blob(tmp_path, encoding):
    blob = tmp_path / "blob"
    blob.write_bytes("concept_id,concept_code,vocabulary_id\n1,Na€,LOCAL\n".encode("cp1252" if encoding else "utf-8"))
    secret = tmp_path / "secret.txt"
    secret.write_text("hunter2")
    opts = {"encoding": encoding} if encoding else {}

    def run(sql):
        return query_file_source(
            str(blob), "concepts.csv", opts, _SELECT, "vocabulary_id, concept_code", sql
        )

    assert run("SELECT concept_code FROM source_concepts") == [{"concept_code": "Na€"}]
    _denied(run, f"SELECT * FROM read_text('{secret}')")
    _refused(run, f"COPY (SELECT 1) TO '{tmp_path / 'out.csv'}'")


@pytest.fixture
def pooled(source):
    key = "test-shared-file-source"
    run = lambda sql: query_file("duckdb", str(source), sql, pool_key=key)  # noqa: E731
    yield run
    connection_pool.invalidate(key)


def test_shared_pool_forgets_what_a_query_created(pooled):
    pooled("CREATE VIEW patients AS SELECT 999 AS id")
    pooled("CREATE MACRO leak() AS 1; SET VARIABLE planted = 1")
    assert pooled("SELECT COUNT(*) AS n FROM patients") == [{"n": 2}]
    assert pooled("SELECT getvariable('planted') AS v") == [{"v": None}]
    with pytest.raises(duckdb.Error):
        pooled("SELECT leak()")


@pytest.mark.parametrize("sql", [
    "COMMIT; CREATE VIEW patients AS SELECT 999 AS id",
    "/* x */ ROLLBACK",
    "DETACH ext",
    "USE memory",
    "ATTACH ':memory:' AS other",
])
def test_shared_pool_refuses_statements_that_outlive_the_query(pooled, sql):
    with pytest.raises(ValueError):
        pooled(sql)
    assert pooled("SELECT COUNT(*) AS n FROM patients") == [{"n": 2}]


def test_shared_pool_settings_are_locked(pooled):
    with pytest.raises(duckdb.Error):
        pooled("SET threads = 1")


def test_shared_parquet_pool_survives_a_dropped_view(tmp_path):
    table = tmp_path / "patients.parquet"
    duckdb.execute(f"COPY (SELECT 1 AS id) TO '{table}' (FORMAT PARQUET)")
    key = "test-shared-parquet-source"
    run = lambda sql: query_parquet_folder(  # noqa: E731
        [("patients.parquet", str(table))], ["patients"], sql, pool_key=key
    )
    try:
        run("DROP VIEW patients")
        assert run("SELECT id FROM patients") == [{"id": 1}]
    finally:
        connection_pool.invalidate(key)
