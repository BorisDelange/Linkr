"""A query on an external database cannot change its connection's configuration:
the server's log stream holds only what Linkr writes, and the memory cap stays."""

import duckdb
import pytest

from app.services.data import connection_pool, db_connect

CONFIG = {"engine": "postgresql", "host": "db.internal", "database": "omop", "schema": "public"}


@pytest.fixture
def external(monkeypatch):
    def attach(con, _config, _password):
        con.execute(f"ATTACH ':memory:' AS {db_connect._ATTACH_ALIAS}")
        con.execute(f"CREATE SCHEMA {db_connect._ATTACH_ALIAS}.public")
        con.execute(f"CREATE TABLE {db_connect._ATTACH_ALIAS}.public.person AS SELECT 1 AS person_id")

    monkeypatch.setattr(db_connect, "_connect", lambda _extension: db_connect._open())
    monkeypatch.setattr(db_connect, "_attach", attach)
    key = "external-config-lock"
    yield lambda sql: db_connect.query_external(CONFIG, "pw", sql, pool_key=key)
    connection_pool.invalidate(key)


@pytest.mark.parametrize("sql", [
    "SET logging_storage='stdout'",
    "SET enable_logging=true",
    "SET memory_limit='100GB'",
    "SET logging_storage='stdout'; SET enable_logging=true; SELECT 1 AS a",
])
def test_a_query_cannot_change_its_connection_configuration(external, sql):
    with pytest.raises(duckdb.Error):
        external(sql)
    assert external("SELECT current_setting('enable_logging') AS on") == [{"on": False}]


def test_an_external_query_still_reads_its_database(external):
    assert external("SELECT person_id FROM person") == [{"person_id": 1}]
    assert external("SET VARIABLE x = 2; SELECT getvariable('x') AS x") == [{"x": 2}]
