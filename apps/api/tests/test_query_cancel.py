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
    try:
        assert query_cancel.cancel("q4", "7") is True
        assert Con.held is True
    finally:
        query_cancel._running.pop("q4", None)
        query_cancel._interrupted.discard("q4")


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


def test_a_query_waiting_for_its_pooled_connection_gives_up_when_cancelled():
    """The connection of a database is used by one query at a time. One cancelled
    while it waits behind a long one must end now, not when the long one does."""
    from app.services.data import connection_pool

    con = duckdb.connect()
    ahead: dict = {}
    release = threading.Event()

    def long_use(c):
        release.wait(10)
        return []

    holder = threading.Thread(target=connection_pool.run_pooled, args=("cancel-wait", lambda: con, long_use))
    holder.start()
    time.sleep(0.1)

    def waiting():
        query_cancel.current_query.set(("q-wait", "7"))
        try:
            connection_pool.run_pooled("cancel-wait", lambda: con, lambda c: [])
        except BaseException as exc:  # noqa: BLE001 — recorded for the assertion
            ahead["error"] = exc

    waiter = threading.Thread(target=contextvars.copy_context().run, args=(waiting,))
    waiter.start()
    time.sleep(0.1)
    try:
        assert query_cancel.cancel("q-wait", "7") is False
        waiter.join(2)
        assert not waiter.is_alive()
        assert isinstance(ahead.get("error"), query_cancel.QueryCancelled)
    finally:
        release.set()
        holder.join(5)
        connection_pool.clear()


def test_a_cancel_for_a_waiting_query_of_another_user_is_ignored():
    query_cancel.cancel("q-other", "8")
    query_cancel.current_query.set(("q-other", "7"))
    try:
        query_cancel.raise_if_cancelled()
    finally:
        query_cancel.current_query.set(None)
        query_cancel._cancelled_early.pop("q-other", None)


def test_a_cancel_between_two_statements_stops_the_next():
    """DuckDB's interrupt only reaches the statement in flight: one landing
    between two statements of a script must not let the next one run."""
    con = duckdb.connect()
    query_cancel.current_query.set(("q-between", "7"))

    def cancel_before_the_second(index, _total, _stmt):
        if index == 1:
            assert query_cancel.cancel("q-between", "7") is True

    with query_cancel.tracking(con), pytest.raises(duckdb.InterruptException):
        db_connect._run_statements(con, "memory", "CREATE TABLE a (x INT); CREATE TABLE b (x INT);",
                                   on_statement=cancel_before_the_second)
    assert con.execute("SELECT count(*) FROM duckdb_tables() WHERE table_name = 'b'").fetchone() == (0,)
    assert "q-between" not in query_cancel._interrupted
