"""A tagged read query can be interrupted from another thread while it runs."""

import contextvars
import threading
import time

import duckdb
import pytest

from app.services.data import db_connect, query_cancel


def _run_tagged(con, sql, query_id, owner, outcome):
    def body():
        query_cancel.current_query.set((query_id, owner))
        try:
            outcome["rows"] = db_connect._run_read(con, "memory", sql, False)
        except BaseException as exc:  # noqa: BLE001 — recorded for the assertion
            outcome["error"] = exc

    ctx = contextvars.copy_context()
    thread = threading.Thread(target=ctx.run, args=(body,))
    thread.start()
    return thread


def test_cancel_interrupts_a_running_query():
    con = duckdb.connect()
    outcome: dict = {}
    thread = _run_tagged(con, "SELECT sum(i * i) FROM range(20000000000) t(i)", "q1", "7", outcome)
    deadline = time.monotonic() + 5
    while "q1" not in query_cancel._running and time.monotonic() < deadline:
        time.sleep(0.01)
    time.sleep(0.1)
    assert query_cancel.cancel("q1", "7") is True
    thread.join(10)
    assert not thread.is_alive()
    assert isinstance(outcome.get("error"), duckdb.InterruptException)
    assert "q1" not in query_cancel._running


def test_another_user_cannot_cancel():
    con = duckdb.connect()
    outcome: dict = {}
    thread = _run_tagged(con, "SELECT sum(i * i) FROM range(3000000000) t(i)", "q2", "7", outcome)
    deadline = time.monotonic() + 5
    while "q2" not in query_cancel._running and time.monotonic() < deadline:
        time.sleep(0.01)
    assert query_cancel.cancel("q2", "8") is False
    query_cancel.cancel("q2", "7")
    thread.join(10)


def test_cancel_before_start_refuses_to_run():
    assert query_cancel.cancel("q3", "7") is False
    outcome: dict = {}
    _run_tagged(duckdb.connect(), "SELECT 1", "q3", "7", outcome).join(5)
    assert isinstance(outcome.get("error"), query_cancel.QueryCancelled)


def test_interrupt_happens_while_the_query_is_still_registered():
    # The tracking block unregisters under the same lock, so an interrupt sent
    # under it cannot reach the next query the pooled connection runs.
    class Con:
        held = None

        def interrupt(self):
            Con.held = query_cancel._lock.locked()

    query_cancel._running["q4"] = ("7", Con())
    assert query_cancel.cancel("q4", "7") is True
    assert Con.held is True


def test_untagged_query_is_untouched():
    assert db_connect._run_read(duckdb.connect(), "memory", "SELECT 42 AS x", False) == [{"x": 42}]


@pytest.fixture(autouse=True)
def _clean():
    yield
    query_cancel._running.clear()
    query_cancel._cancelled_early.clear()


def test_row_cap_can_be_raised_for_the_request():
    con = duckdb.connect()
    assert len(db_connect._run_read(con, "memory", "SELECT * FROM range(20000)", False)) == db_connect.MAX_QUERY_ROWS
    token = db_connect.row_cap.set(db_connect.MAX_QUERY_ROWS_ALL)
    try:
        assert len(db_connect._run_read(con, "memory", "SELECT * FROM range(20000)", False)) == 20000
    finally:
        db_connect.row_cap.reset(token)
