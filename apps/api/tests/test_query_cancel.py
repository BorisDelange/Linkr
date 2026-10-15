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

    query_cancel._running["q4"] = ("7", Con(), None)
    assert query_cancel.cancel("q4", "7") is True
    assert Con.held is True


def test_cancel_also_runs_the_query_hook():
    """A pushed-down query stops on the database's side through its hook."""
    calls: list[str] = []

    class Con:
        def interrupt(self):
            calls.append("interrupt")

    token = query_cancel.current_query.set(("q5", "7"))
    try:
        with query_cancel.on_cancel(lambda: calls.append("hook")), query_cancel.tracking(Con()):
            assert query_cancel.cancel("q5", "7") is True
    finally:
        query_cancel.current_query.reset(token)
    assert calls == ["interrupt", "hook"]


def test_a_slow_hook_does_not_hold_the_lock():
    """The hook reaches another database; a query registering meanwhile must
    not wait for it."""
    hook_started, hook_release = threading.Event(), threading.Event()

    def slow_hook():
        hook_started.set()
        hook_release.wait(5)

    class Con:
        def interrupt(self):
            pass

    query_cancel._running["q6"] = ("7", Con(), slow_hook)
    cancelling = threading.Thread(target=query_cancel.cancel, args=("q6", "7"))
    cancelling.start()
    assert hook_started.wait(5)
    try:
        registered = threading.Event()

        def register():
            query_cancel.current_query.set(("q7", "7"))
            with query_cancel.tracking(Con()):
                registered.set()

        threading.Thread(target=contextvars.copy_context().run, args=(register,)).start()
        assert registered.wait(2), "tracking waited for the cancel hook"
    finally:
        hook_release.set()
        cancelling.join(5)


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


def test_progress_reads_how_far_a_running_query_has_read():
    con = db_connect._open()
    con.execute("CREATE TABLE big AS SELECT range i FROM range(30000000)")
    outcome: dict = {}
    thread = _run_tagged(con, "SELECT count(DISTINCT i % 9999991), sum(i * i) FROM big", "q4", "7", outcome)
    seen: list[float] = []
    while thread.is_alive():
        value = query_cancel.progress("q4", "7")
        if value is not None:
            seen.append(value)
        assert query_cancel.progress("q4", "8") is None
        time.sleep(0.01)
    thread.join()
    assert "rows" in outcome
    assert seen and all(0 < v <= 100 for v in seen)
    assert query_cancel.progress("q4", "7") is None
