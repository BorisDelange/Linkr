"""PostgreSQL and MySQL logins are checked at attach. One that can write, or that
cannot be checked, still attaches read-only, but postgres_query() / mysql_query(),
whose text goes to the database as is, are refused on its database."""

import duckdb
import pytest
import sqlglot

from app.core.refusal import refusal_detail
from app.services.data import db_connect, read_only_logins
from app.services.data.community_engines import LoginNotReadOnly
from app.services.data.read_only_logins import (
    MYSQL_LOGIN_SQL,
    MYSQL_PRIVILEGES_SQL,
    Verdict,
    mysql_grantee,
    mysql_write_privileges,
    postgres_write_privileges,
)

PG = {"engine": "postgresql", "host": "pg.internal", "port": 5432, "database": "omop", "username": "reader"}
MYSQL = {"engine": "mysql", "host": "my.internal", "port": 3306, "database": "omop", "username": "reader"}


@pytest.fixture(autouse=True)
def _fresh_verdicts():
    read_only_logins._verdicts.clear()
    read_only_logins._warned.clear()
    yield
    read_only_logins._verdicts.clear()
    read_only_logins._warned.clear()


# ── PostgreSQL: the privilege check's row ────────────────────────────────────

def _pg_row(**over):
    row = {"login": "reader", "attributes": "", "predefined_roles": "", "table_privileges": "",
           "sequence_privileges": "", "schema_create": False, "database_create": False, "owned": 0,
           "security_definer": 0, "dblink": False}
    row.update(over)
    return [tuple(row.values())]


def test_a_postgres_login_with_only_select_is_read_only():
    assert postgres_write_privileges(_pg_row()) == []
    assert postgres_write_privileges(_pg_row(predefined_roles="pg_monitor,pg_read_all_data,pg_read_all_stats")) == []
    assert postgres_write_privileges(_pg_row(attributes=None, table_privileges=None)) == []


def test_what_lets_a_postgres_login_write():
    held = postgres_write_privileges(_pg_row(
        attributes="CREATEDB,SUPERUSER", predefined_roles="pg_read_all_data,pg_write_all_data,pg_database_owner",
        table_privileges="DELETE,INSERT,TRUNCATE", sequence_privileges="USAGE",
        schema_create=True, database_create=True, owned=3, security_definer=2, dblink=True,
    ))
    assert held == [
        "CREATEDB", "SUPERUSER", "pg_write_all_data", "pg_database_owner", "DELETE", "INSERT", "TRUNCATE",
        "USAGE ON SEQUENCE", "CREATE ON SCHEMA", "CREATE ON DATABASE", "OWNERSHIP",
        "EXECUTE ON SECURITY DEFINER FUNCTION", "dblink",
    ]


@pytest.mark.parametrize("role", ["pg_write_server_files", "pg_execute_server_program", "pg_signal_backend",
                                  "pg_read_server_files", "pg_maintain", "pg_checkpoint"])
def test_a_predefined_role_that_is_not_a_reader_counts(role):
    assert postgres_write_privileges(_pg_row(predefined_roles=role)) == [role]


@pytest.mark.parametrize("rows", [[], _pg_row() * 2, [_pg_row()[0][:-1]], _pg_row(attributes=["SUPERUSER"])])
def test_a_postgres_check_of_another_shape_proves_nothing(rows):
    with pytest.raises((ValueError, TypeError)):
        postgres_write_privileges(rows)


def test_the_postgres_check_is_one_select_of_ten_columns():
    tree = sqlglot.parse_one(read_only_logins.POSTGRES_CHECK_SQL, read="postgres")
    assert isinstance(tree, sqlglot.exp.Select) and len(tree.expressions) == 10


# ── MySQL / MariaDB: information_schema ──────────────────────────────────────

ME = "'reader'@'%'"


def _privileges(*privileges: str, grantable: str = "NO", grantee: str = ME) -> list[tuple]:
    return [(grantee, p, grantable) for p in privileges]


@pytest.mark.parametrize(("current_user", "grantee"), [
    ("reader@%", "'reader'@'%'"),
    ("reader@10.0.0.%", "'reader'@'10.0.0.%'"),
    ("svc@corp@db.internal", "'svc@corp'@'db.internal'"),
])
def test_the_login_is_matched_as_information_schema_spells_it(current_user, grantee):
    assert mysql_grantee(current_user) == grantee


def test_a_mysql_login_reading_one_database_is_read_only():
    rows = _privileges("USAGE") + _privileges("SELECT", "SHOW VIEW")
    assert mysql_write_privileges("reader@%", 0, 0, rows) == []


@pytest.mark.parametrize(("rows", "writes"), [
    (_privileges("SELECT", "SHOW DATABASES", "SHOW_ROUTINE"), []),
    (_privileges("SELECT", "INSERT"), ["INSERT"]),
    (_privileges("USAGE", "SYSTEM_VARIABLES_ADMIN"), ["SYSTEM_VARIABLES_ADMIN"]),
    (_privileges("select", "update"), ["UPDATE"]),
    (_privileges("SELECT", grantable="YES"), ["GRANT OPTION"]),
    (_privileges("PROCESS", "FILE", "FILE"), ["PROCESS", "FILE"]),
])
def test_only_reading_privileges_are_read_only(rows, writes):
    assert mysql_write_privileges("reader@%", 0, 0, _privileges("USAGE") + rows) == writes


def test_other_accounts_rows_are_not_the_logins():
    rows = _privileges("USAGE") + _privileges("SELECT", "INSERT", "DROP", grantee="'root'@'localhost'")
    assert mysql_write_privileges("reader@%", 0, 0, rows) == []


def test_a_grant_to_public_counts_for_the_login():
    rows = _privileges("USAGE") + _privileges("INSERT", grantee="PUBLIC")
    assert mysql_write_privileges("reader@%", 0, 0, rows) == ["INSERT"]


def test_a_login_holding_a_role_stays_unverified():
    with pytest.raises(ValueError):
        mysql_write_privileges("reader@%", 1, 0, _privileges("USAGE", "SELECT"))


def test_a_login_that_sees_a_routine_stays_unverified():
    with pytest.raises(ValueError):
        mysql_write_privileges("reader@%", 0, 2, _privileges("USAGE", "SELECT"))


def test_no_privilege_of_the_login_proves_nothing():
    with pytest.raises(ValueError):
        mysql_write_privileges("reader@%", 0, 0, _privileges("SELECT", grantee="'other'@'%'"))


@pytest.mark.parametrize("sql", [MYSQL_LOGIN_SQL, MYSQL_PRIVILEGES_SQL])
def test_the_mysql_check_is_plain_selects(sql):
    tree = sqlglot.parse_one(sql, read="mysql")
    assert isinstance(tree, (sqlglot.exp.Select, sqlglot.exp.Union))
    assert "SHOW" not in sql.upper()


# ── The verdict at attach ────────────────────────────────────────────────────

class _CheckCon:
    """Answers the login checks; records what was sent."""

    def __init__(self, pg_row=None, privileges=None, roles=0, fail=False):
        self.sql: list[str] = []
        self.pg_row, self.privileges, self.roles, self.fail = pg_row, privileges or [], roles, fail
        self._rows: list[tuple] = []

    def execute(self, sql, *_args):
        self.sql.append(sql)
        if self.fail and ("postgres_query" in sql or "mysql_query" in sql):
            raise duckdb.IOException("permission denied for table pg_authid")
        if "postgres_query" in sql:
            self._rows = self.pg_row
        elif "APPLICABLE_ROLES" in sql:
            self._rows = [("reader@%", self.roles, 0)]
        elif "mysql_query" in sql:
            self._rows = self.privileges
        return self

    def fetchall(self):
        return self._rows


def test_a_login_that_can_write_still_attaches_and_is_remembered():
    con = _CheckCon(pg_row=_pg_row(table_privileges="INSERT,UPDATE", owned=4))
    db_connect._attach_external(con, "ext", PG, "pw")
    assert any(s.upper().startswith("ATTACH") and "READ_ONLY" in s for s in con.sql)
    _, verdict = read_only_logins._attached[con]["ext"]
    assert verdict.held == ("INSERT", "UPDATE", "OWNERSHIP") and not verdict.read_only


def test_a_verdict_serves_the_next_attach_of_the_same_login():
    db_connect._attach_external(_CheckCon(privileges=_privileges("USAGE", "SELECT")), "ext", MYSQL, "pw")
    con = _CheckCon()
    db_connect._attach_external(con, "source", MYSQL, "pw")
    assert not any("mysql_query" in s for s in con.sql)
    assert read_only_logins._attached[con]["source"][1].read_only
    read_only_logins.forget(MYSQL)
    con = _CheckCon(privileges=_privileges("USAGE", "SELECT"))
    db_connect._attach_external(con, "source", MYSQL, "pw")
    assert any("APPLICABLE_ROLES" in s for s in con.sql)


def test_a_check_that_fails_leaves_the_login_unverified_and_is_tried_again(caplog):
    con = _CheckCon(fail=True)
    db_connect._attach_external(con, "ext", PG, "pw")
    verdict = read_only_logins._attached[con]["ext"][1]
    assert not verdict.verified and not verdict.read_only
    assert "could not be verified" in caplog.text
    assert read_only_logins._verdicts == {}


def test_a_login_that_can_write_is_logged_once(caplog):
    for _ in range(3):
        db_connect._attach_external(_CheckCon(privileges=_privileges("USAGE", "INSERT")), "ext",
                                    MYSQL, "pw")
        read_only_logins.forget(MYSQL)
    assert caplog.text.count("can write (INSERT)") == 1


# ── The text functions, given the verdict ────────────────────────────────────

@pytest.fixture
def attached(monkeypatch):
    """A real connection on which `ext` reads as a PostgreSQL database and `my` as
    a MySQL one, each with the verdict the test gives."""
    con = duckdb.connect()
    monkeypatch.setattr(read_only_logins, "_databases",
                        lambda _con, kind: {"postgres": ["ext", "other"], "mysql": ["my"]}[kind])

    def verdicts(**by_alias: Verdict):
        for alias, verdict in by_alias.items():
            read_only_logins.remember(con, alias, None, verdict)
        return con

    return verdicts


WRITER = Verdict("postgresql", ("INSERT", "SUPERUSER"), steps="GRANT …")
READER = Verdict("postgresql")


def test_postgres_query_is_refused_on_a_database_whose_login_can_write(attached):
    con = attached(ext=WRITER, other=READER)
    with pytest.raises(LoginNotReadOnly) as refused:
        db_connect._statements_to_run(con, "SELECT * FROM postgres_query('ext', 'SELECT 1')")
    assert refusal_detail(refused.value) == {
        "code": "postgres_login_not_read_only", "message": str(refused.value),
        "function": "postgres_query", "held": "INSERT, SUPERUSER", "steps": "GRANT …",
    }
    assert db_connect._statements_to_run(con, "SELECT * FROM postgres_query('other', 'SELECT 1')")


def test_a_database_named_another_way_is_still_refused(attached):
    con = attached(ext=WRITER, other=READER)
    with pytest.raises(LoginNotReadOnly):
        db_connect._statements_to_run(con, "SELECT * FROM postgres_query('EXT', 'SELECT 1')")
    with pytest.raises(LoginNotReadOnly):
        db_connect._reject_passthrough_calls("SELECT * FROM postgres_query(db, 'SELECT 1')", con=con)


def test_a_login_proven_read_only_keeps_the_text_functions(attached):
    con = attached(ext=READER, other=READER, my=read_only_logins.READ_ONLY)
    db_connect._statements_to_run(con, "SELECT * FROM postgres_query('ext', 'SELECT 1')")
    db_connect._statements_to_run(con, "SELECT * FROM mysql_query('my', 'SHOW TABLES')")
    with pytest.raises(ValueError, match="one statement that reads"):
        db_connect._statements_to_run(con, "SELECT * FROM mysql_query('my', 'DELETE FROM t')")


def test_a_database_attached_without_a_verdict_counts_as_unverified(attached):
    con = attached(ext=READER, other=READER)
    with pytest.raises(LoginNotReadOnly) as refused:
        db_connect._statements_to_run(con, "SELECT * FROM mysql_query('my', 'SELECT 1')")
    assert refused.value.code == "mysql_login_unverified" and "held" not in refused.value.detail


def test_an_unverified_login_is_refused_too(attached):
    con = attached(ext=Verdict("postgresql", verified=False, steps="GRANT …"), other=READER)
    with pytest.raises(LoginNotReadOnly) as refused:
        db_connect._statements_to_run(con, "SELECT 1; SELECT * FROM postgres_query('ext', 'SELECT 1')")
    assert refused.value.code == "postgres_login_unverified"


def test_the_refusal_reaches_text_inside_query_and_stored_macros(attached, monkeypatch):
    monkeypatch.setattr(db_connect, "_has_passthrough_attach", lambda _con: True)
    con = attached(ext=WRITER, other=READER)
    with pytest.raises(LoginNotReadOnly):
        db_connect._reject_passthrough_calls(
            "SELECT * FROM query('SELECT * FROM postgres_query(''ext'', ''SELECT 1'')')", con=con)
    con.execute("CREATE MACRO m(db) AS TABLE SELECT * FROM postgres_query(db, 'SELECT 1')")
    with pytest.raises(LoginNotReadOnly):
        db_connect._reject_stored_passthrough(con, ["memory"])


def test_a_fresher_verdict_on_the_login_replaces_the_connections(monkeypatch):
    con = duckdb.connect()
    monkeypatch.setattr(read_only_logins, "_databases", lambda _con, kind: ["ext"] if kind == "postgres" else [])
    key = read_only_logins.login_key(PG)
    read_only_logins.remember(con, "ext", key, WRITER)
    with pytest.raises(LoginNotReadOnly):
        db_connect._statements_to_run(con, "SELECT * FROM postgres_query('ext', 'SELECT 1')")
    read_only_logins._verdicts[key] = (read_only_logins.time.monotonic(), READER)
    db_connect._statements_to_run(con, "SELECT * FROM postgres_query('ext', 'SELECT 1')")
