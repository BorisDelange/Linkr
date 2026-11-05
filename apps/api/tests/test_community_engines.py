"""SQL Server and Oracle through DuckDB community extensions: never downloaded by
the server, attached read-only behind a login proven read-only, their passthrough
functions refused to user SQL, Oracle's text-typed numbers cast back."""

import duckdb
import pytest

from app.services.data import community_engines, db_connect

SQLSERVER = {"engine": "sqlserver", "host": "mssql.internal", "database": "omop", "username": "reader"}
ORACLE = {"engine": "oracle", "host": "oracle.internal", "database": "FREEPDB1", "username": "reader", "schema": "CDM"}


class _FakeCon:
    """Records the SQL an attach sends; answers each passthrough query from `answers`
    (the first key found in the SQL wins)."""

    def __init__(self, answers: dict[str, list[tuple]]):
        self.sql: list[str] = []
        self._answers = answers
        self._rows: list[tuple] = []

    def execute(self, sql: str, params=None):
        self.sql.append(sql)
        self._rows = next((rows for key, rows in self._answers.items() if key in sql), [])
        return self

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


@pytest.mark.parametrize("sql", [
    "SELECT * FROM mssql_scan('ext', 'DROP TABLE person; SELECT 1')",
    "SELECT mssql_exec('ext', 'DELETE FROM person')",
    'SELECT * FROM "ORACLE_EXECUTE"(\'linkr_ext\', \'DELETE FROM person\')',
    "SELECT * FROM oracle_execute_admin /* x */ ('linkr_ext', 'DROP TABLE person')",
    "SELECT * FROM main.oracle_plsql('linkr_ext', 'BEGIN NULL; END;')",
    "SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT * FROM oracle_query(''linkr_ext'', ''DELETE FROM person'')'))",
    "SELECT * FROM JSON_EXECUTE_SERIALIZED_SQL(json_serialize_sql('SELECT 1'))",
    "CALL postgres_execute('src', 'DELETE FROM person')",
    "CALL mysql_execute('src', 'DELETE FROM person')",
])
def test_passthrough_functions_are_refused(sql):
    with pytest.raises(ValueError, match="read-only guard"):
        db_connect._reject_session_statements(sql)
    with pytest.raises(ValueError, match="read-only guard"):
        db_connect._reject_forbidden_statements(sql)
    with pytest.raises(ValueError, match="read-only guard"):
        db_connect._run_statements(duckdb.connect(), "memory", sql)


def test_dynamic_sql_is_refused_only_beside_a_community_database():
    sql = "SELECT * FROM query('SELECT * FROM ' || 'mssql_scan(''ext'', ''x'')')"
    db_connect._reject_passthrough_calls(sql)
    with pytest.raises(ValueError, match="read-only guard"):
        db_connect._reject_passthrough_calls(sql, dynamic_sql=True)
    assert db_connect._run_statements(duckdb.connect(), "memory", "SELECT * FROM query('SELECT 1 AS x')") == [{"x": 1}]


def test_query_table_is_refused_beside_a_community_database():
    sql = "SELECT * FROM query_table('oracle_' || 'query')"
    db_connect._reject_passthrough_calls(sql)
    with pytest.raises(ValueError, match="read-only guard"):
        db_connect._reject_passthrough_calls(sql, dynamic_sql=True)


@pytest.mark.parametrize("engine", ["postgres", "mysql", "mssql"])
def test_dynamic_sql_is_refused_beside_any_database_that_runs_text(engine):
    con = _FakeCon({"duckdb_databases": [("duckdb",), (engine,)]})
    assert db_connect._has_passthrough_attach(con)
    with pytest.raises(ValueError, match="read-only guard"):
        db_connect._run_statements(con, "memory", "SELECT * FROM query('SELECT ' || 'x')")


def test_dynamic_sql_stays_available_beside_local_databases():
    con = duckdb.connect()
    con.execute("ATTACH ':memory:' AS local_copy")
    assert not db_connect._has_passthrough_attach(con)
    assert db_connect._run_statements(con, "memory", "SELECT * FROM query('SELECT 1 AS x')") == [{"x": 1}]


@pytest.mark.parametrize("sql", [
    "SELECT query, oracle_id FROM t",
    "SELECT 'mssql_scan(x)' AS s",
    "SELECT * FROM mysql_query('ext', 'SELECT 1')",
])
def test_lookalikes_are_not(sql):
    db_connect._reject_session_statements(sql)


def test_a_missing_extension_is_never_downloaded(tmp_path):
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{tmp_path}'")
    con.execute("SET autoinstall_known_extensions = false")
    with pytest.raises(ValueError, match="npm run duckdb:extensions -- --community"):
        db_connect._install(con, "mssql")
    assert not any(tmp_path.rglob("*.duckdb_extension*"))


def test_sqlserver_attaches_read_only_through_a_secret():
    con = _FakeCon({"IS_SRVROLEMEMBER": [(0, 0, 0, 0, 0, 0, 0, 0, 0)]})
    community_engines.attach(con, "ext", SQLSERVER, "it's")
    secret, attach = con.sql[0], con.sql[1]
    assert "TYPE mssql" in secret and "PASSWORD 'it''s'" in secret and "USE_ENCRYPT true" in secret
    assert "PORT 1433" in secret
    assert attach == 'ATTACH \'\' AS "ext" (TYPE mssql, SECRET "linkr_ext", READ_ONLY)'


def test_a_sqlserver_login_that_can_write_is_refused():
    con = _FakeCon({"IS_SRVROLEMEMBER": [(0, 0, 1, 0, 1, 1, 1, 0, 0)]})
    with pytest.raises(ValueError, match="db_datawriter, INSERT, UPDATE, DELETE"):
        community_engines.attach(con, "ext", SQLSERVER, "pw")


def test_a_sqlserver_login_granted_writes_on_one_schema_is_refused():
    con = _FakeCon({
        "IS_SRVROLEMEMBER": [(0,) * 9],
        "fn_my_permissions": [("CONNECT",), ("SELECT",), ("VIEW DEFINITION",), ("REFERENCES",),
                              ("INSERT",), ("ALTER",), ("EXECUTE",)],
    })
    with pytest.raises(ValueError, match="holds ALTER, EXECUTE, INSERT"):
        community_engines.attach(con, "ext", SQLSERVER, "pw")
    query = next(s for s in con.sql if "fn_my_permissions" in s)
    assert "CROSS APPLY fn_my_permissions(s.name, ''SCHEMA'')" in query


def test_a_sqlserver_login_that_only_reads_on_its_schemas_is_accepted():
    con = _FakeCon({
        "IS_SRVROLEMEMBER": [(0,) * 9],
        "fn_my_permissions": [("CONNECT",), ("SELECT",), ("VIEW DEFINITION",), ("REFERENCES",), ("SHOWPLAN",)],
    })
    community_engines.attach(con, "ext", SQLSERVER, "pw")


@pytest.mark.parametrize("perm", [
    "INSERT", "update", "EXECUTE", "EXECUTE ANY EXTERNAL SCRIPT", "EXECUTE EXTERNAL SCRIPT",
    "BACKUP DATABASE", "BACKUP LOG", "ADMINISTER DATABASE BULK OPERATIONS", "CHECKPOINT",
    "KILL DATABASE CONNECTION", "ALTER ANY SCHEMA", "CREATE TABLE", "CONTROL", "TAKE OWNERSHIP",
    "IMPERSONATE", "ENABLE LEDGER", " backup  log ",
])
def test_a_sqlserver_permission_that_writes_is_classified_as_such(perm):
    assert community_engines._is_sqlserver_write_permission(perm)


@pytest.mark.parametrize("perm", [
    "CONNECT", "SELECT", "REFERENCES", "SHOWPLAN", "VIEW DEFINITION", "VIEW DATABASE STATE",
    "SUBSCRIBE QUERY NOTIFICATIONS", "AUTHENTICATE",
])
def test_a_sqlserver_read_permission_is_not(perm):
    assert not community_engines._is_sqlserver_write_permission(perm)


def _oracle(privs, table_privs=(), owned=0, columns=()):
    return _FakeCon({
        "session_privs": [(p,) for p in privs],
        "user_tab_privs": [(p,) for p in table_privs],
        "user_tables": [(str(owned),)],
        "all_tab_columns": list(columns),
    })


def test_an_oracle_login_that_owns_tables_or_can_write_is_refused():
    with pytest.raises(ValueError, match="owns 3 table"):
        community_engines.attach(_oracle(["CREATE SESSION"], owned=3), "ext", ORACLE, "pw")
    with pytest.raises(ValueError, match="CREATE TABLE, INSERT"):
        community_engines.attach(_oracle(["CREATE SESSION", "CREATE TABLE"], ["SELECT", "INSERT"]), "ext", ORACLE, "pw")


def test_oracle_tables_are_typed_lower_case_views_over_oracle_query():
    columns = [
        ("CDM", "PERSON", "PERSON_ID", "NUMBER", "19", "0"),
        ("CDM", "PERSON", "GENDER_CONCEPT_ID", "NUMBER", None, "0"),  # INTEGER
        ("CDM", "PERSON", "Weight", "FLOAT", "126", None),
        ("CDM", "PERSON", "VALUE", "NUMBER", None, None),
        ("CDM", "PERSON", "RANGE", "NUMBER", "18", "4"),
        ("CDM", "PERSON", "BIRTH_DATETIME", "DATE", None, None),
    ]
    con = _oracle(["CREATE SESSION", "SELECT ANY TABLE"], ["SELECT"], columns=columns)
    community_engines.attach(con, "ext", ORACLE, "pw")
    assert "ATTACH ':memory:' AS \"ext\"" in con.sql
    assert not any("TYPE oracle_scanner" in s for s in con.sql)
    view = next(s for s in con.sql if s.startswith("CREATE VIEW"))
    assert view == (
        'CREATE VIEW "ext".main."person" AS SELECT CAST("PERSON_ID" AS BIGINT) AS "person_id", '
        'CAST("GENDER_CONCEPT_ID" AS BIGINT) AS "gender_concept_id", CAST("Weight" AS DOUBLE) AS "Weight", '
        'CAST("VALUE" AS DOUBLE) AS "value", CAST("RANGE" AS DECIMAL(18,4)) AS "range", '
        '"BIRTH_DATETIME" AS "birth_datetime" FROM oracle_query(\'linkr_ext\', '
        '\'SELECT "PERSON_ID", "GENDER_CONCEPT_ID", "Weight", "VALUE", "RANGE", "BIRTH_DATETIME" FROM "CDM"."PERSON"\')'
    )


def test_oracle_reads_one_schema_and_sqlserver_defaults_to_dbo():
    assert db_connect._scope(ORACLE) == "main"
    assert db_connect._scope(SQLSERVER) == "dbo"
    assert db_connect._scope({**SQLSERVER, "schema": "cdm"}) == "cdm"
    assert db_connect.port_of(ORACLE) == 1521


def test_project_code_cannot_attach_them_yet():
    with pytest.raises(ValueError, match="not available from project code"):
        db_connect.attach_recipe(ORACLE, "pw")


def test_not_materialized_hints_are_dropped_for_sql_server():
    sql = "WITH x AS NOT MATERIALIZED (SELECT 1), y AS not /* c */ materialized (SELECT 2) SELECT 'NOT MATERIALIZED' FROM x, y"
    assert db_connect._materialization_left_to_duckdb(sql) == (
        "WITH x AS (SELECT 1), y AS (SELECT 2) SELECT 'NOT MATERIALIZED' FROM x, y"
    )
