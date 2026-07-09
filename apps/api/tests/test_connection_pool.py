"""Connection pool: reuse across calls, per-source invalidation, self-heal on a
dead connection, and TTL eviction. Uses in-memory DuckDB connections so the
tests exercise the real lifecycle without a remote database."""

import duckdb
import pytest

from app.services.data import connection_pool


@pytest.fixture(autouse=True)
def _clean_pool():
    connection_pool.clear()
    yield
    connection_pool.clear()


def _use(con):
    return con.execute("SELECT 42 AS n").fetchall()


def test_setup_runs_once_then_connection_is_reused():
    calls = {"n": 0}

    def setup():
        calls["n"] += 1
        return duckdb.connect()

    for _ in range(3):
        rows = connection_pool.run_pooled("src-1", setup, _use)
        assert rows == [(42,)]
    assert calls["n"] == 1  # warm connection reused, not rebuilt each call


def test_distinct_keys_get_distinct_connections():
    seen = []

    def setup():
        con = duckdb.connect()
        seen.append(con)
        return con

    connection_pool.run_pooled("a", setup, _use)
    connection_pool.run_pooled("b", setup, _use)
    assert len(seen) == 2
    assert seen[0] is not seen[1]


def test_invalidate_forces_a_fresh_setup():
    calls = {"n": 0}

    def setup():
        calls["n"] += 1
        return duckdb.connect()

    connection_pool.run_pooled("src", setup, _use)
    connection_pool.invalidate("src")
    connection_pool.run_pooled("src", setup, _use)
    assert calls["n"] == 2


def test_dead_connection_self_heals():
    """A warm connection that raises a ConnectionException is discarded and the
    call retried once with a fresh setup."""
    cons = []

    def setup():
        con = duckdb.connect()
        cons.append(con)
        return con

    state = {"first": True}

    def use(con):
        if state["first"]:
            state["first"] = False
            raise duckdb.ConnectionException("connection dropped")
        return _use(con)

    rows = connection_pool.run_pooled("src", setup, use)
    assert rows == [(42,)]
    assert len(cons) == 2  # rebuilt after the dead connection


def test_ttl_eviction_closes_idle_connections(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "pool_ttl_seconds", 0, raising=False)
    calls = {"n": 0}

    def setup():
        calls["n"] += 1
        return duckdb.connect()

    connection_pool.run_pooled("src", setup, _use)
    # ttl=0 → the entry is immediately stale, so the next access sweeps it and
    # rebuilds.
    connection_pool.run_pooled("src", setup, _use)
    assert calls["n"] == 2
