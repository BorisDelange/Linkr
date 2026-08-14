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


def test_path_rejects_an_id_that_is_not_a_uuid(data_dir):
    with pytest.raises(ValueError):
        managed_db.path_for("../../etc/passwd")
    with pytest.raises(ValueError):
        managed_db.path_for("not-a-uuid")


def test_path_is_canonical_so_case_cannot_collide(data_dir):
    """Two ids differing only in case must map to the same file (they are the same
    UUID) rather than two files that clash on a case-insensitive filesystem."""
    upper = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
    lower = upper.lower()
    assert managed_db.path_for(upper) == managed_db.path_for(lower)


def test_delete_removes_the_file(data_dir):
    sid = "44444444-4444-4444-4444-444444444444"
    managed_db.create_from_ddl(sid, DDL)
    managed_db.delete(sid)
    assert not managed_db.exists(sid)
    managed_db.delete(sid)  # no error on a second call


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
