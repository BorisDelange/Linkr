"""Doris as an external engine: reached over the MySQL protocol, attached without
READ_ONLY (Doris rejects `START TRANSACTION READ ONLY`), so a login that can write
must be refused instead."""

import json
import os
import time

import duckdb
import pytest

from app.services.data import connection_pool, db_connect, pushdown, query_cancel
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
    assert db_connect._scope({**DORIS, "schema": "core"}) == "core"


def test_without_a_default_schema_mysql_has_none_and_postgres_public():
    assert db_connect._scope({**DORIS, "database": None}) is None
    assert db_connect._scope({"engine": "postgresql", "database": "warehouse"}) == "public"


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
    grants = [{"UserIdentity": "'root'@'%'", "Roles": "operator", "GlobalPrivs": "Node_priv,Admin_priv", "DatabasePrivs": None}]
    assert db_connect._doris_write_privileges(grants) == ["Admin_priv", "Node_priv"]


def test_usage_on_capacity_is_not_a_write_privilege():
    grants = [{**READ_ONLY_GRANTS[0], "ResourcePrivs": "spark0: Usage_priv", "ComputeGroupPrivs": "cg: Usage_priv"}]
    assert db_connect._doris_write_privileges(grants) == []


def test_an_empty_grants_result_is_refused():
    """Fail closed: no row proves nothing about the login."""
    with pytest.raises(ValueError, match="cannot verify.*no row"):
        db_connect._attach_external(_FakeCon([]), "ext", DORIS, None)


def test_grants_without_the_privilege_columns_are_refused():
    """A Doris that renamed the columns would otherwise read as read-only."""
    renamed = [{"UserIdentity": "'reader'@'%'", "Global": "Admin_priv", "Database": "internal.omop: Load_priv"}]
    with pytest.raises(ValueError, match="cannot verify.*GlobalPrivs, DatabasePrivs"):
        db_connect._attach_external(_FakeCon(renamed), "ext", DORIS, None)
    with pytest.raises(ValueError, match="no DatabasePrivs column"):
        db_connect._doris_write_privileges([{"UserIdentity": "'reader'@'%'", "GlobalPrivs": None}])


# --- Pushdown: fallback and cancel ------------------------------------------


class _IdCon:
    """Answers the CONNECTION_ID() probe a pushed-down run starts with."""

    def execute(self, sql: str):
        assert "CONNECTION_ID()" in sql
        return self

    def fetchone(self):
        return (42,)

    def close(self):
        pass


@pytest.fixture
def pushed(monkeypatch):
    monkeypatch.setattr(pushdown, "_pushed_down", lambda con, config, sql: RemoteQuery("REMOTE", ("n",)))
    monkeypatch.setattr(pushdown, "_passthrough", lambda config, remote: remote.sql)


def test_a_query_the_database_cannot_prepare_runs_locally(pushed):
    ran: list[str] = []

    def run(q: str):
        ran.append(q)
        if q == "REMOTE":
            raise duckdb.IOException('Failed to prepare MySQL query "…": Unknown function')
        return "local rows"

    assert pushdown._with_pushdown(_IdCon(), DORIS, None, "LOCAL", run) == "local rows"
    assert ran == ["REMOTE", "LOCAL"]


def test_a_query_that_failed_running_is_not_retried_locally(pushed):
    """Out of memory on Doris: the ATTACH would pull every row instead. The
    engine's message is what the user reads."""
    def run(q: str):
        raise duckdb.IOException('Failed to execute MySQL query "…": MEM_LIMIT_EXCEEDED')

    with pytest.raises(pushdown.RemoteQueryFailed, match="MEM_LIMIT_EXCEEDED") as failed:
        pushdown._with_pushdown(_IdCon(), DORIS, None, "LOCAL", run)
    assert isinstance(failed.value.__cause__, duckdb.IOException)


def test_a_run_time_failure_is_not_a_dead_pooled_connection(pushed):
    """connection_pool re-attaches and runs `use` again on an IOException; a
    statement Doris failed must not be run a second time that way."""
    uses, setups = [], []

    def run(q: str):
        raise duckdb.IOException('Failed to execute MySQL query "…": MEM_LIMIT_EXCEEDED')

    def use(con):
        uses.append(con)
        return pushdown._with_pushdown(con, DORIS, None, "LOCAL", run)

    def setup():
        setups.append(1)
        return _IdCon()

    try:
        with pytest.raises(pushdown.RemoteQueryFailed, match="MEM_LIMIT_EXCEEDED"):
            connection_pool.run_pooled("doris-test", setup, use)
    finally:
        connection_pool.clear()
    assert len(uses) == 1 and len(setups) == 1


class _CatalogueCon:
    """Answers the information_schema.columns passthrough with `rows`."""

    def __init__(self, *rows):
        self.rows = list(rows)

    def execute(self, sql):
        return self

    def fetchall(self):
        return self.rows


def test_the_remote_tables_cache_is_per_login():
    """Two logins may see different tables of the same database."""
    pushdown._remote_columns_cache.clear()
    try:
        assert list(pushdown._remote_tables(_CatalogueCon(("omop", "a", "id", "bigint")), DORIS)) == [("omop", "a")]
        other = {**DORIS, "username": "other"}
        assert list(pushdown._remote_tables(_CatalogueCon(("omop", "b", "id", "bigint")), other)) == [("omop", "b")]
        assert list(pushdown._remote_tables(_CatalogueCon(("omop", "c", "id", "bigint")), DORIS)) == [("omop", "a")]
    finally:
        pushdown._remote_columns_cache.clear()


def test_the_remote_tables_span_every_data_schema_but_the_system_ones():
    pushdown._remote_columns_cache.clear()
    try:
        con = _CatalogueCon(
            ("CORE", "patient", "id", "bigint"), ("VOCAB", "concept", "code", "varchar"), ("mysql", "user", "Host", "char"),
        )
        lookup = pushdown._table_lookup(con, {**DORIS, "database": "CORE"})
        assert lookup(None, "PATIENT").schema == "CORE"
        assert lookup("vocab", "concept").columns == {"code": "VARCHAR"}
        assert lookup("mysql", "user") is None
        assert lookup(None, "concept") is None
    finally:
        pushdown._remote_columns_cache.clear()


def test_a_cancelled_pushed_down_query_kills_it_remotely_and_reads_as_cancelled(pushed, monkeypatch):
    killed: list[int] = []
    monkeypatch.setattr(pushdown._RemoteKill, "_kill", lambda self: killed.append(self.connection_id))

    def run_cancelled(q: str):
        hook = query_cancel._cancel_hook.get()
        hook()
        raise duckdb.IOException('Failed to execute MySQL query "…": cancel query by user')

    with pytest.raises(duckdb.InterruptException):
        pushdown._with_pushdown(_IdCon(), DORIS, None, "LOCAL", run_cancelled)
    time.sleep(0.05)  # the kill runs on its own thread
    assert killed == [42]


def test_the_search_path_lists_every_data_schema_default_first():
    """A preset naming a second schema (`vocab.concept`) read "schema does not
    exist" while the default schema alone was on the path."""
    con = duckdb.connect()
    try:
        con.execute("ATTACH ':memory:' AS ext")
        for schema in ("CORE", "VOCAB", "mysql", "sys"):
            con.execute(f'CREATE SCHEMA ext."{schema}"')
        con.execute('CREATE TABLE ext."CORE".patient AS SELECT 1 AS id')
        con.execute('CREATE TABLE ext."VOCAB".concept AS SELECT 2 AS id')
        path = db_connect._external_search_path(con, {**DORIS, "database": "core"})
        assert path.startswith('memory,ext."CORE",')
        assert 'ext."mysql"' not in path and 'ext."sys"' not in path
        con.execute(f"SET search_path='{path}'")
        assert con.execute("SELECT id FROM patient").fetchall() == [(1,)]
        assert con.execute("SELECT id FROM vocab.concept").fetchall() == [(2,)]
    finally:
        con.close()


# Opt-in live test against a Doris holding two databases, for example the
# all-in-one image (`docker run -p 19030:9030 apache/doris:all-in-one-4.1.3`)
# seeded with CLIN_CORE.patient(patient_id, …), CLIN_CORE.event(patient_id,
# concept_code, …), CLIN_VOCAB.concept(concept_code, label) and a SELECT-only login:
#   LINKR_TEST_DORIS='{"engine":"doris","host":"127.0.0.1","port":19030,
#                      "database":"CLIN_CORE","username":"reader","password":"reader"}'
_LIVE_DORIS = os.environ.get("LINKR_TEST_DORIS")


@pytest.mark.skipif(not _LIVE_DORIS, reason="set LINKR_TEST_DORIS to run the live Doris tests")
@pytest.mark.parametrize("push", [False, True])
def test_live_doris_joins_two_databases(push):
    config = json.loads(_LIVE_DORIS or "{}")
    sql = (
        "SELECT c.label, COUNT(*) AS n FROM event e "
        "JOIN CLIN_VOCAB.concept c ON c.concept_code = e.concept_code GROUP BY c.label ORDER BY c.label"
    )
    rows = db_connect.query_external(config, config.get("password"), sql, pushdown=push)
    assert rows and all(set(r) == {"label", "n"} for r in rows)


@pytest.mark.skipif(not _LIVE_DORIS, reason="set LINKR_TEST_DORIS to run the live Doris tests")
def test_live_doris_introspection_names_the_other_databases_tables():
    config = json.loads(_LIVE_DORIS or "{}")
    names = {t["name"] for t in db_connect.introspect_external(config, config.get("password"))}
    assert {"patient", "event", "CLIN_VOCAB.concept"} <= names
    assert not any(n.lower().startswith(("mysql.", "information_schema.")) for n in names)
