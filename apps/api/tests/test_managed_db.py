"""Managed (server-owned, writable) DuckDB databases and ETL runs.

A pipeline target is created empty from a schema's DDL and written to by every
ETL script, so unlike an uploaded source it needs a mutable file of its own and
a connection where several databases are attached at once.
"""

import duckdb
import pytest

from app.services.data import db_connect, managed_db


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(type(settings), "data_path", property(lambda _: tmp_path))
    return tmp_path


DDL = """
CREATE TABLE person (person_id BIGINT, gender_concept_id INTEGER);
CREATE TABLE concept (concept_id BIGINT, concept_name VARCHAR);
"""


def test_create_from_ddl_makes_a_real_file_with_the_tables(data_dir):
    path = managed_db.create_from_ddl("11111111-1111-1111-1111-111111111111", DDL)
    con = duckdb.connect(path, read_only=True)
    tables = {r[0] for r in con.execute("SHOW TABLES").fetchall()}
    con.close()
    assert tables == {"person", "concept"}


def test_create_is_idempotent_and_leaves_no_half_schema(data_dir):
    sid = "22222222-2222-2222-2222-222222222222"
    managed_db.create_from_ddl(sid, DDL)
    managed_db.create_from_ddl(sid, "CREATE TABLE only_this (x INTEGER);")
    con = duckdb.connect(managed_db.path_for(sid).as_posix(), read_only=True)
    tables = {r[0] for r in con.execute("SHOW TABLES").fetchall()}
    con.close()
    assert tables == {"only_this"}


def test_a_failing_ddl_does_not_leave_a_file_behind(data_dir):
    sid = "33333333-3333-3333-3333-333333333333"
    with pytest.raises(Exception):
        managed_db.create_from_ddl(sid, "CREATE TABLE t (x INTEGER); NOT SQL AT ALL;")
    assert not managed_db.exists(sid)


def test_foreign_key_constraints_are_skipped(data_dir):
    """The OMOP DDL ends with ~176 `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN
    KEY`, which DuckDB rejects outright. Creating the database must still work —
    the browser path skips them the same way."""
    sid = "aaaaaaaa-0000-0000-0000-000000000000"
    ddl = DDL + """
    ALTER TABLE person ADD CONSTRAINT fpk_person_gender FOREIGN KEY
      (gender_concept_id) REFERENCES concept (concept_id);
    """
    managed_db.create_from_ddl(sid, ddl)
    con = duckdb.connect(managed_db.path_for(sid).as_posix(), read_only=True)
    tables = {r[0] for r in con.execute("SHOW TABLES").fetchall()}
    con.close()
    assert tables == {"person", "concept"}


# What `path_for` accepts is covered by test_managed_db_path.py. It stopped
# requiring a UUID (an imported database keeps the readable slug its repo
# declares), so the two tests that lived here — "rejects a non-UUID" and "folds
# case to one canonical file" — encoded a rule that no longer holds.


def test_delete_removes_the_file(data_dir):
    sid = "44444444-4444-4444-4444-444444444444"
    managed_db.create_from_ddl(sid, DDL)
    managed_db.delete(sid)
    assert not managed_db.exists(sid)
    managed_db.delete(sid)  # no error on a second call


# --- Compaction -------------------------------------------------------------


def _fill(sid: str, rows: int = 300000) -> None:
    """A managed file with a droppable table big enough to leave real slack."""
    managed_db.create_from_ddl(sid, DDL)
    con = duckdb.connect(managed_db.path_for(sid).as_posix())
    con.execute(
        "CREATE TABLE junk AS "
        f"SELECT i, hash(i)::VARCHAR AS pad FROM range({rows}) t(i)"
    )
    con.close()


def _leave_slack(sid: str, rows: int = 300000) -> int:
    """Free blocks stranded in the MIDDLE of the file, and return its size.

    Not simply "write then drop": when the freed blocks sit at the end of the
    file, DuckDB truncates on checkpoint and the space comes back on its own.
    What compaction is for is the other case — a table dropped with live data
    written after it, so the hole cannot be truncated away. That is the shape an
    ETL rebuilding its tables leaves behind.
    """
    managed_db.create_from_ddl(sid, DDL)
    path = managed_db.path_for(sid)
    con = duckdb.connect(path.as_posix())
    con.execute(
        f"CREATE TABLE junk AS SELECT i, hash(i)::VARCHAR AS pad FROM range({rows}) t(i)"
    )
    con.execute(
        f"CREATE TABLE tail AS SELECT i, hash(i)::VARCHAR AS pad FROM range({rows}) t(i)"
    )
    con.close()

    con = duckdb.connect(path.as_posix())
    con.execute("DROP TABLE junk")
    con.execute("CHECKPOINT")
    con.close()
    return path.stat().st_size


def test_compact_shrinks_a_file_with_stranded_free_blocks(data_dir):
    """The point of the feature: blocks freed in the middle of the file stay in it
    — a checkpoint can only truncate what is at the end — so a rewrite is the only
    thing that returns them to the filesystem."""
    sid = "c0000000-0000-0000-0000-000000000001"
    after_drop = _leave_slack(sid)

    before, after = managed_db.compact(sid)
    assert before == after_drop  # the drop alone did not reclaim the hole
    assert after < before


def test_compact_preserves_tables_and_views(data_dir):
    sid = "c0000000-0000-0000-0000-000000000002"
    managed_db.create_from_ddl(sid, DDL)
    con = duckdb.connect(managed_db.path_for(sid).as_posix())
    con.execute("INSERT INTO person VALUES (7, 8507)")
    con.execute("CREATE VIEW v AS SELECT person_id FROM person")
    con.close()

    managed_db.compact(sid)

    con = duckdb.connect(managed_db.path_for(sid).as_posix(), read_only=True)
    assert con.execute("SELECT person_id FROM person").fetchall() == [(7,)]
    assert con.execute("SELECT * FROM v").fetchall() == [(7,)]
    con.close()


def test_compact_leaves_no_temp_file_behind(data_dir):
    sid = "c0000000-0000-0000-0000-000000000003"
    _fill(sid, rows=1000)
    managed_db.compact(sid)
    leftovers = [p.name for p in managed_db.path_for(sid).parent.iterdir()
                 if "compacting" in p.name]
    assert leftovers == []


def test_compact_on_a_missing_file_is_a_value_error(data_dir):
    """Not a DuckDB crash: the route maps ValueError to 400, anything else to 422."""
    with pytest.raises(ValueError, match="missing"):
        managed_db.compact("c0000000-0000-0000-0000-000000000004")


def test_compact_reports_progress_monotonically(data_dir):
    """`COPY FROM DATABASE` is one statement, so the bytes written are the only
    progress signal available — they must never go backwards."""
    sid = "c0000000-0000-0000-0000-000000000005"
    _fill(sid)
    seen: list[int] = []
    managed_db.compact(sid, seen.append)
    assert seen == sorted(seen)


def test_data_size_excludes_free_blocks(data_dir):
    """The denominator for the progress bar. It must follow the DATA, not the file:
    using the file size would stall the bar low and then jump to 100%."""
    sid = "c0000000-0000-0000-0000-000000000006"
    file_size = _leave_slack(sid)

    est = managed_db.data_size(sid)
    assert est is not None
    assert est < file_size

    # And it predicts the compacted size closely enough to drive a percentage.
    _, after = managed_db.compact(sid)
    assert abs(after - est) <= max(after, est) * 0.25


def test_data_size_is_none_for_a_missing_file(data_dir):
    assert managed_db.data_size("c0000000-0000-0000-0000-000000000007") is None


def test_a_second_compaction_of_the_same_database_is_refused(data_dir):
    """Two concurrent rewrites of one file would each os.replace their own copy
    into place, so the loser would silently discard the winner's work."""
    import asyncio

    from app.models.data_source import DataSource
    from app.services import data_source_service

    sid = "c0000000-0000-0000-0000-000000000008"
    _fill(sid, rows=400000)
    source = DataSource(id=sid, alias="t", name="t", connection_config={"managed": True})

    async def scenario():
        first = await data_source_service.start_compaction(source)
        try:
            with pytest.raises(ValueError, match="already running"):
                await data_source_service.start_compaction(source)
        finally:
            # Let the detached task finish so it cannot outlive the test.
            while first.status == "running":
                await asyncio.sleep(0.05)
        assert first.status == "done"

    asyncio.run(scenario())
    data_source_service._compactions.pop(sid, None)


# --- ETL runs ---------------------------------------------------------------


def test_etl_writes_to_the_target_and_persists(data_dir):
    sid = "55555555-5555-5555-5555-555555555555"
    target = managed_db.create_from_ddl(sid, DDL)
    db_connect.run_etl_sql(target, "INSERT INTO target.person VALUES (1, 8507);")

    con = duckdb.connect(target, read_only=True)
    assert con.execute("SELECT count(*) FROM person").fetchone()[0] == 1
    con.close()


def test_unqualified_writes_land_on_the_target(data_dir):
    sid = "66666666-6666-6666-6666-666666666666"
    target = managed_db.create_from_ddl(sid, DDL)
    db_connect.run_etl_sql(target, "INSERT INTO person VALUES (2, 8532);")
    con = duckdb.connect(target, read_only=True)
    assert con.execute("SELECT person_id FROM person").fetchall() == [(2,)]
    con.close()


def test_one_statement_can_read_a_source_and_write_the_target(data_dir):
    """The reason for the in-memory hub: a per-source connection cannot do this."""
    src = data_dir / "raw.duckdb"
    con = duckdb.connect(src.as_posix())
    con.execute("CREATE TABLE patients (subject_id BIGINT)")
    con.execute("INSERT INTO patients VALUES (42), (43)")
    con.close()

    sid = "77777777-7777-7777-7777-777777777777"
    target = managed_db.create_from_ddl(sid, DDL)
    db_connect.run_etl_sql(
        target,
        "INSERT INTO target.person SELECT subject_id, 0 FROM source.patients;",
        {"source": {"kind": "file", "engine": "duckdb", "path": src.as_posix()}},
    )

    con = duckdb.connect(target, read_only=True)
    assert con.execute("SELECT count(*) FROM person").fetchone()[0] == 2
    con.close()


def test_a_role_database_is_read_only(data_dir):
    src = data_dir / "ro.duckdb"
    con = duckdb.connect(src.as_posix())
    con.execute("CREATE TABLE t (x INTEGER)")
    con.close()

    sid = "88888888-8888-8888-8888-888888888888"
    target = managed_db.create_from_ddl(sid, DDL)
    with pytest.raises(Exception):
        db_connect.run_etl_sql(
            target,
            "INSERT INTO source.t VALUES (1);",
            {"source": {"kind": "file", "engine": "duckdb", "path": src.as_posix()}},
        )


def test_a_parquet_role_is_reachable_by_role_name(data_dir):
    pq = data_dir / "d_items.parquet"
    con = duckdb.connect()
    con.execute(
        f"COPY (SELECT 220045 AS itemid, 'HR' AS label) TO '{pq}' (FORMAT parquet)"
    )
    con.close()

    sid = "99999999-9999-9999-9999-999999999999"
    target = managed_db.create_from_ddl(sid, DDL)
    rows = db_connect.run_etl_sql(
        target,
        "SELECT label FROM source.d_items;",
        {
            "source": {
                "kind": "parquet",
                "files": [("d_items.parquet", pq.as_posix())],
                "known": [],
            }
        },
    )
    assert rows == [{"label": "HR"}]


def test_etl_sql_cannot_install_extensions_or_read_the_filesystem(data_dir):
    """The client SQL runs with extensions locked and, when no file-backed role is
    attached, external access disabled — so it cannot pull httpfs to exfiltrate or
    read arbitrary paths off the server."""
    sid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    target = managed_db.create_from_ddl(sid, DDL)
    with pytest.raises(Exception):
        db_connect.run_etl_sql(target, "INSTALL httpfs;")
    with pytest.raises(Exception):
        db_connect.run_etl_sql(
            target, "SELECT * FROM read_csv_auto('/etc/passwd');"
        )


def test_etl_sql_cannot_install_httpfs_even_when_a_role_needs_the_filesystem(data_dir):
    """The case the previous guard missed, and the common one in practice.

    `enable_external_access` can only be cut when NOTHING legitimate needs the
    filesystem. As soon as mapping data or a parquet/external role is present — the
    normal shape of a real pipeline — it has to stay on, and `_lock_down_user_sql`
    alone does not stop an EXPLICIT `INSTALL httpfs; LOAD httpfs` (it only disables
    auto-loading). That handed any script outbound network access. The statement
    check closes it regardless of the external-access state."""
    sid = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    target = managed_db.create_from_ddl(sid, DDL)
    mapping = {"codes": "code,label\nA,HR\n"}

    for sql in ("INSTALL httpfs;", "LOAD httpfs;", "FORCE INSTALL httpfs;"):
        with pytest.raises(ValueError, match="not allowed in a pipeline script"):
            db_connect.run_etl_sql(target, sql, None, mapping)

    # ATTACH would open an arbitrary database file (and collide with the role
    # attaches the runner owns).
    with pytest.raises(ValueError, match="not allowed in a pipeline script"):
        db_connect.run_etl_sql(target, "ATTACH '/etc/passwd' AS evil;", None, mapping)

    # A statement hidden behind a legitimate one is still caught.
    with pytest.raises(ValueError, match="not allowed in a pipeline script"):
        db_connect.run_etl_sql(target, "SELECT 1;\nINSTALL httpfs;", None, mapping)


def test_etl_sql_cannot_hide_a_forbidden_statement_behind_a_comment(data_dir):
    """A leading comment must not hide the statement's first keyword.

    `_FORBIDDEN_IN_USER_SQL` is anchored, and the splitter keeps comments attached
    to the statement they precede. A block comment therefore used to sit in front
    of the keyword and defeat the anchor: `/* x */ INSTALL httpfs` was ALLOWED, and
    with a parquet/mapping role present (external access necessarily on) it really
    did load the extension and reach the network."""
    sid = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
    target = managed_db.create_from_ddl(sid, DDL)
    mapping = {"codes": "code,label\nA,HR\n"}

    for sql in (
        "/* x */ INSTALL httpfs;",
        "/* x */ LOAD httpfs;",
        "/* multi\n   line */ INSTALL httpfs;",
        "-- line\nINSTALL httpfs;",
        "/* a */ -- b\n /* c */ LOAD httpfs;",
        "SELECT 1; /* x */ ATTACH '/etc/passwd' AS evil;",
        # A BARE CARRIAGE RETURN ends a line comment for DuckDB, so scanning only
        # for \n swallowed the whole payload as one "comment" and the anchored
        # check never saw the keyword — while DuckDB executed it. Verified
        # against real DuckDB: `--x\rSELECT 42` returns 42, and this exact
        # payload left httpfs installed and loaded.
        "--\rINSTALL httpfs;",
        "--\rLOAD httpfs;",
        "--\r\nINSTALL httpfs;",
        "SELECT 1;\n-- c\rATTACH '/etc/passwd' AS evil;",
    ):
        with pytest.raises(ValueError, match="not allowed in a pipeline script"):
            db_connect.run_etl_sql(target, sql, None, mapping)


def test_split_statements_does_not_cut_inside_comments_or_dollar_quotes(data_dir):
    """Parity with the frontend tokenizer: a `;` inside a block comment, a dollar
    quote or a quoted identifier is not a statement boundary. Splitting there
    produced syntax-error fragments from a script that runs fine in the browser."""
    assert db_connect._split_statements("/* a; b */ SELECT 1;") == [
        "/* a; b */ SELECT 1"
    ]
    assert db_connect._split_statements("SELECT $$a;b$$ AS s;") == [
        "SELECT $$a;b$$ AS s"
    ]
    assert db_connect._split_statements('SELECT 1 AS "a;b";') == [
        'SELECT 1 AS "a;b"'
    ]
    assert db_connect._split_statements("SELECT 'a;b';") == ["SELECT 'a;b'"]
    # Two real statements still split.
    assert db_connect._split_statements("SELECT 1; SELECT 2;") == [
        "SELECT 1",
        "SELECT 2",
    ]
    # A bare \r ends the comment, so what follows is a real statement — not part
    # of it. Without this the whole line reads as one comment and its `;` is
    # invisible, which is what let the extension guard be bypassed.
    assert db_connect._split_statements("-- c\rSELECT 1;") == ["-- c\rSELECT 1"]
    assert db_connect._split_statements("-- c\rSELECT 1; SELECT 2;") == [
        "-- c\rSELECT 1",
        "SELECT 2",
    ]
    # \r\n must not leave a stray \n that reads as a second line.
    assert db_connect._split_statements("-- c\r\nSELECT 1;") == ["-- c\r\nSELECT 1"]


def test_etl_sql_still_runs_normal_statements_mentioning_those_words(data_dir):
    """The check must not fire on the words inside strings or comments — the
    splitter drops both before it looks at the leading keyword."""
    sid = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    target = managed_db.create_from_ddl(sid, DDL)
    rows = db_connect.run_etl_sql(
        target,
        "-- install httpfs\nSELECT 'ATTACH is fine in a literal' AS s;",
    )
    assert rows == [{"s": "ATTACH is fine in a literal"}]


def test_etl_rejects_a_role_name_that_is_not_an_identifier(data_dir):
    sid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    target = managed_db.create_from_ddl(sid, DDL)
    with pytest.raises(Exception):
        db_connect.run_etl_sql(
            target,
            "SELECT 1;",
            {'x" AS y; ATTACH \'evil\' AS "z': {"kind": "file", "path": "/tmp/x"}},
        )
