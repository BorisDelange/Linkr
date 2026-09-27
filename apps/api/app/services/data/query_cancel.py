"""Stop a read query that is still running, from another request.

A data catalog run fires queries that can scan billions of rows, and pausing it
must not wait for the one in flight to finish. So the client tags a query with
an id, and to stop it posts that id to the cancel route: the connection running
it is interrupted (DuckDB's `interrupt()` is safe from another thread) and the
query fails with `duckdb.InterruptException`.

The tag travels in a ContextVar set by the route rather than as one more
argument through every query function: `asyncio.to_thread` copies the context
into the worker thread, where the statement runner reads it.

A cancel can land before its query reaches a connection (it is still waiting on
the pooled connection's lock); the id is then remembered briefly and the query
refuses to start.
"""

import contextlib
import contextvars
import threading
import time
from collections.abc import Iterator

import duckdb

# (query id, owner) of the query the current request runs, or None.
current_query: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar("current_query", default=None)

_EARLY_CANCEL_TTL_S = 60.0

_lock = threading.Lock()
_running: dict[str, tuple[str, duckdb.DuckDBPyConnection]] = {}
_cancelled_early: dict[str, tuple[str, float]] = {}


class QueryCancelled(Exception):
    """The query was cancelled before it started."""


@contextlib.contextmanager
def tracking(con: duckdb.DuckDBPyConnection) -> Iterator[None]:
    """Make the tagged query running on `con` cancellable for its duration."""
    tag = current_query.get()
    if tag is None:
        yield
        return
    query_id, owner = tag
    with _lock:
        early = _cancelled_early.pop(query_id, None)
        if early is not None and early[0] == owner:
            raise QueryCancelled(query_id)
        _running[query_id] = (owner, con)
    try:
        yield
    finally:
        with _lock:
            _running.pop(query_id, None)


def cancel(query_id: str, owner: str) -> bool:
    """Interrupt `owner`'s query `query_id`. True when a running query was hit."""
    now = time.monotonic()
    with _lock:
        for key in [k for k, (_, at) in _cancelled_early.items() if now - at > _EARLY_CANCEL_TTL_S]:
            del _cancelled_early[key]
        entry = _running.get(query_id)
        if entry is None:
            _cancelled_early[query_id] = (owner, now)
            return False
        if entry[0] != owner:
            return False
        # Under the lock: once released, the query could finish and the pooled
        # connection start another request's query, which would be interrupted.
        try:
            entry[1].interrupt()
        except Exception:  # noqa: BLE001 — a query finishing as we interrupt is fine
            return False
    return True
