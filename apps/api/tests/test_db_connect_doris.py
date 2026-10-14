"""Doris as an external engine: reached over the MySQL protocol, attached without
READ_ONLY (Doris rejects `START TRANSACTION READ ONLY`), so a login that can write
must be refused instead."""

import time

import duckdb
import pytest

from app.services.data import db_connect, query_cancel
from app.services.data.remote_sql import RemoteQuery

DORIS = {"engine": "doris", "host": "doris.internal", "port": 9030, "database": "omop", "username": "reader"}


class _FakeCon:
    """Records the SQL an attach sends; answers SHOW GRANTS with `grants`."""

    def __init__(self, grants: list[dict] | None = None):
        self.sql: list[str] = []
        self._grants = grants or []
        self.description = None

    def execute(self, sql: str):
        self.sql.append(sql)
        if "SHOW GRANTS" in sql:
            names = sorted({k for row in self._grants for k in row})
            self.description = [(n,) for n in names]
            self._rows = [tuple(row.get(n) for n in names) for row in self._grants]
        return self

    def fetchall(self):
        return self._rows


READ_ONLY_GRANTS = [{
    "UserIdentity": "'reader'@'%'",
    "GlobalPrivs": None,
    "DatabasePrivs": "internal.information_schema: Select_priv; internal.omop: Select_priv,Show_view_priv",
    "WorkloadGroupPrivs": "normal: Usage_priv",
}]


def test_doris_dsn_uses_the_mysql_keys():
    assert db_connect._dsn(DORIS, None) == "host=doris.internal port=9030 database=omop user=reader"


def test_doris_scope_is_its_database():
    assert db_connect._scope(DORIS) == "omop"


def test_doris_recipe_is_not_read_only_attach():
    recipe = db_connect.attach_recipe(DORIS, "pw")
    assert recipe["type"] == "mysql"
    assert recipe["readOnly"] is False
    assert db_connect.attach_recipe({**DORIS, "engine": "mysql"}, "pw")["readOnly"] is True


def test_doris_attaches_without_read_only_and_checks_the_login():
    con = _FakeCon(READ_ONLY_GRANTS)
    db_connect._attach_external(con, "ext", DORIS, "it's")
    attach = con.sql[0]
    assert attach.endswith('AS "ext" (TYPE mysql)')
    # The DSN's own quote is backslash-escaped, then doubled for the SQL literal.
    assert "password=it\\''s" in attach
    assert any("SHOW GRANTS" in s for s in con.sql)


def test_mysql_still_attaches_read_only_without_a_grants_check():
    con = _FakeCon()
    db_connect._attach_external(con, "source", {**DORIS, "engine": "mysql"}, None)
    assert con.sql == [con.sql[0]]
    assert con.sql[0].endswith('AS "source" (TYPE mysql, READ_ONLY)')


def test_doris_login_that_can_write_is_refused():
    grants = [{**READ_ONLY_GRANTS[0], "DatabasePrivs": "internal.omop: Select_priv,Load_priv"}]
    with pytest.raises(ValueError, match="Load_priv"):
        db_connect._attach_external(_FakeCon(grants), "ext", DORIS, None)


def test_doris_admin_role_privileges_are_write_privileges():
    grants = [{"UserIdentity": "'root'@'%'", "Roles": "operator", "GlobalPrivs": "Node_priv,Admin_priv"}]
    assert db_connect._doris_write_privileges(grants) == ["Admin_priv", "Node_priv"]


def test_usage_on_capacity_is_not_a_write_privilege():
    grants = [{**READ_ONLY_GRANTS[0], "ResourcePrivs": "spark0: Usage_priv", "ComputeGroupPrivs": "cg: Usage_priv"}]
    assert db_connect._doris_write_privileges(grants) == []


# --- Pushdown: fallback and cancel ------------------------------------------


class _IdCon:
    """Answers the CONNECTION_ID() probe a pushed-down run starts with."""

    def execute(self, sql: str):
        assert "CONNECTION_ID()" in sql
        return self

    def fetchone(self):
        return (42,)


@pytest.fixture
def pushed(monkeypatch):
    monkeypatch.setattr(db_connect, "_pushed_down", lambda con, config, sql: RemoteQuery("REMOTE", ("n",)))
    monkeypatch.setattr(db_connect, "_passthrough", lambda config, remote: remote.sql)


def test_a_query_the_database_cannot_prepare_runs_locally(pushed):
    ran: list[str] = []

    def run(q: str):
        ran.append(q)
        if q == "REMOTE":
            raise duckdb.IOException('Failed to prepare MySQL query "…": Unknown function')
        return "local rows"

    assert db_connect._with_pushdown(_IdCon(), DORIS, None, "LOCAL", run) == "local rows"
    assert ran == ["REMOTE", "LOCAL"]


def test_a_query_that_failed_running_is_not_retried_locally(pushed):
    """Out of memory on Doris: the ATTACH would pull every row instead."""
    def run(q: str):
        raise duckdb.IOException('Failed to execute MySQL query "…": MEM_LIMIT_EXCEEDED')

    with pytest.raises(duckdb.IOException, match="MEM_LIMIT_EXCEEDED"):
        db_connect._with_pushdown(_IdCon(), DORIS, None, "LOCAL", run)


def test_a_cancelled_pushed_down_query_kills_it_remotely_and_reads_as_cancelled(pushed, monkeypatch):
    killed: list[int] = []
    monkeypatch.setattr(db_connect._RemoteKill, "_kill", lambda self: killed.append(self.connection_id))

    def run_cancelled(q: str):
        hook = query_cancel._cancel_hook.get()
        hook()
        raise duckdb.IOException('Failed to execute MySQL query "…": cancel query by user')

    with pytest.raises(duckdb.InterruptException):
        db_connect._with_pushdown(_IdCon(), DORIS, None, "LOCAL", run_cancelled)
    time.sleep(0.05)  # the kill runs on its own thread
    assert killed == [42]
