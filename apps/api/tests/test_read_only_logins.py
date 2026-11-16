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
    MySQLGrant,
    Verdict,
    mysql_write_privileges,
    parse_mysql_grant,
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


# ── MySQL / MariaDB: SHOW GRANTS lines ───────────────────────────────────────

@pytest.mark.parametrize(("line", "grant"), [
    ("GRANT USAGE ON *.* TO `reader`@`%`", MySQLGrant(("USAGE",), "*.*")),
    ("GRANT SELECT, SHOW VIEW ON `omop`.* TO `reader`@`%`", MySQLGrant(("SELECT", "SHOW VIEW"), "`omop`.*")),
    ("GRANT SELECT ON `omop`.`person` TO 'reader'@'10.0.0.%'", MySQLGrant(("SELECT",), "`omop`.`person`")),
    ("GRANT SELECT (`a`, `b ON c`), INSERT (`c`) ON `omop`.`t` TO `reader`@`%`",
     MySQLGrant(("SELECT", "INSERT"), "`omop`.`t`")),
    ("GRANT ALL PRIVILEGES ON `scratch`.* TO `reader`@`%`", MySQLGrant(("ALL PRIVILEGES",), "`scratch`.*")),
    ("GRANT ALL ON *.* TO `root`@`localhost` WITH GRANT OPTION",
     MySQLGrant(("ALL PRIVILEGES",), "*.*", grant_option=True)),
    ("GRANT SELECT, CREATE TEMPORARY TABLES, LOCK TABLES ON `omop`.* TO `reader`@`%`",
     MySQLGrant(("SELECT", "CREATE TEMPORARY TABLES", "LOCK TABLES"), "`omop`.*")),
    ("GRANT APPLICATION_PASSWORD_ADMIN,SYSTEM_VARIABLES_ADMIN,SHOW_ROUTINE ON *.* TO `ops`@`%`",
     MySQLGrant(("APPLICATION_PASSWORD_ADMIN", "SYSTEM_VARIABLES_ADMIN", "SHOW_ROUTINE"), "*.*")),
    ("GRANT EXECUTE ON PROCEDURE `omop`.`refresh` TO `reader`@`%`",
     MySQLGrant(("EXECUTE",), "PROCEDURE `omop`.`refresh`")),
    ("GRANT PROXY ON ''@'' TO 'root'@'localhost' WITH GRANT OPTION", MySQLGrant(("PROXY",), "''@''", grant_option=True)),
    ("GRANT USAGE ON *.* TO `reader`@`%` IDENTIFIED BY PASSWORD '*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19'",
     MySQLGrant(("USAGE",), "*.*")),
    ("GRANT `analyst`@`%`,`loader`@`%` TO `reader`@`%`", MySQLGrant(roles=("`analyst`@`%`", "`loader`@`%`"))),
    ("GRANT `analyst` TO `reader`@`%` WITH ADMIN OPTION", MySQLGrant(roles=("`analyst`",), admin_option=True)),
    ("grant select on omop.* to reader@'%'", MySQLGrant(("SELECT",), "omop.*")),
])
def test_a_grant_line_reads_as_its_privileges_or_roles(line, grant):
    assert parse_mysql_grant(line) == grant


@pytest.mark.parametrize("line", [
    "REVOKE INSERT ON `mysql`.* FROM `reader`@`%`",
    "SET DEFAULT ROLE `analyst` FOR `reader`@`%`",
])
def test_a_line_that_grants_nothing_is_skipped(line):
    assert parse_mysql_grant(line) is None


@pytest.mark.parametrize("line", ["", "Grants for reader@%", "GRANT SELECT", "GRANT ON *.* TO x", "GRANT SELECT, ON *.* TO x",
                                  "GRANT SELECT (`a` ON `t` TO x", "GRANT 'x' ON *.* TO y"])
def test_a_grant_line_it_cannot_read_is_refused(line):
    with pytest.raises(ValueError):
        parse_mysql_grant(line)


@pytest.mark.parametrize(("line", "writes"), [
    ("GRANT USAGE ON *.* TO `reader`@`%`", []),
    ("GRANT SELECT, SHOW VIEW, SHOW DATABASES ON *.* TO `reader`@`%`", []),
    ("GRANT SELECT (`a`), UPDATE (`b`) ON `omop`.`t` TO `reader`@`%`", ["UPDATE"]),
    ("GRANT SELECT ON `omop`.* TO `reader`@`%` WITH GRANT OPTION", ["GRANT OPTION"]),
    ("GRANT PROCESS, FILE, RELOAD ON *.* TO `reader`@`%`", ["PROCESS", "FILE", "RELOAD"]),
    ("GRANT BINLOG_ADMIN ON *.* TO `reader`@`%`", ["BINLOG_ADMIN"]),
])
def test_only_reading_privileges_are_read_only(line, writes):
    assert parse_mysql_grant(line).writes == writes


def _answers(table: dict[str, list[str]]):
    asked: list[str] = []

    def show_grants(statement: str) -> list[str]:
        asked.append(statement)
        if statement not in table:
            raise duckdb.CatalogException(f"refused: {statement}")
        return table[statement]

    return show_grants, asked


def test_a_mysql_login_reading_one_database_is_read_only():
    show, _ = _answers({"SHOW GRANTS": [
        "GRANT USAGE ON *.* TO `reader`@`%`", "GRANT SELECT, SHOW VIEW ON `omop`.* TO `reader`@`%`",
    ]})
    assert mysql_write_privileges(show) == []


def test_a_role_granted_to_the_login_counts_through_using():
    show, asked = _answers({
        "SHOW GRANTS": ["GRANT USAGE ON *.* TO `reader`@`%`", "GRANT `etl`@`%` TO `reader`@`%`"],
        "SHOW GRANTS FOR CURRENT_USER() USING `etl`@`%`": [
            "GRANT USAGE ON *.* TO `reader`@`%`", "GRANT INSERT, DELETE ON `omop`.* TO `reader`@`%`",
            "GRANT `etl`@`%` TO `reader`@`%`",
        ],
    })
    assert mysql_write_privileges(show) == ["INSERT", "DELETE"]
    assert asked == ["SHOW GRANTS", "SHOW GRANTS FOR CURRENT_USER() USING `etl`@`%`"]


def test_mariadb_roles_are_read_one_by_one():
    show, _ = _answers({
        "SHOW GRANTS": ["GRANT `etl` TO `reader`@`%`", "GRANT USAGE ON *.* TO `reader`@`%`",
                        "SET DEFAULT ROLE `etl` FOR `reader`@`%`"],
        "SHOW GRANTS FOR `etl`": ["GRANT ALL PRIVILEGES ON `omop`.* TO `etl`"],
    })
    assert mysql_write_privileges(show) == ["ALL PRIVILEGES"]


def test_roles_that_cannot_be_read_leave_the_login_unverified():
    show, _ = _answers({"SHOW GRANTS": ["GRANT `etl`@`%` TO `reader`@`%`"]})
    with pytest.raises(duckdb.Error):
        mysql_write_privileges(show)


def test_no_grant_at_all_proves_nothing():
    show, _ = _answers({"SHOW GRANTS": []})
    with pytest.raises(ValueError):
        mysql_write_privileges(show)


# ── The verdict at attach ────────────────────────────────────────────────────

class _CheckCon:
    """Answers the login checks; records what was sent."""

    def __init__(self, pg_row=None, grants=None, fail=False):
        self.sql: list[str] = []
        self.pg_row, self.grants, self.fail = pg_row, grants or [], fail
        self._rows: list[tuple] = []

    def execute(self, sql, *_args):
        self.sql.append(sql)
        if self.fail and ("postgres_query" in sql or "mysql_query" in sql):
            raise duckdb.IOException("permission denied for table pg_authid")
        if "postgres_query" in sql:
            self._rows = self.pg_row
        elif "mysql_query" in sql:
            self._rows = [(g,) for g in self.grants]
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
    db_connect._attach_external(_CheckCon(grants=["GRANT SELECT ON `omop`.* TO `reader`@`%`"]), "ext", MYSQL, "pw")
    con = _CheckCon()
    db_connect._attach_external(con, "source", MYSQL, "pw")
    assert not any("mysql_query" in s for s in con.sql)
    assert read_only_logins._attached[con]["source"][1].read_only
    read_only_logins.forget(MYSQL)
    con = _CheckCon(grants=["GRANT SELECT ON `omop`.* TO `reader`@`%`"])
    db_connect._attach_external(con, "source", MYSQL, "pw")
    assert any("SHOW GRANTS" in s for s in con.sql)


def test_a_check_that_fails_leaves_the_login_unverified_and_is_tried_again(caplog):
    con = _CheckCon(fail=True)
    db_connect._attach_external(con, "ext", PG, "pw")
    verdict = read_only_logins._attached[con]["ext"][1]
    assert not verdict.verified and not verdict.read_only
    assert "could not be verified" in caplog.text
    assert read_only_logins._verdicts == {}


def test_a_login_that_can_write_is_logged_once(caplog):
    for _ in range(3):
        db_connect._attach_external(_CheckCon(grants=["GRANT INSERT ON `omop`.* TO `reader`@`%`"]), "ext",
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
