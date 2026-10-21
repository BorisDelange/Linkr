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

A query DuckDB hands to an external database (a pushed-down passthrough) does
not stop on `interrupt()`: DuckDB waits for the remote statement to end. Such a
query registers a hook (`on_cancel`) that stops it on the database's side.
"""

import contextlib
import contextvars
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator

import duckdb

# (query id, owner) of the query the current request runs, or None.
current_query: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar("current_query", default=None)

# A heavy query can wait in its lane behind a catalog job for hours before it
# reaches a connection: its cancel must still be there when it does. An entry
# is a few bytes and goes as soon as its query starts.
_EARLY_CANCEL_TTL_S = 24 * 3600.0
# Past it the oldest are forgotten: any user can post ids that never start.
_EARLY_CANCEL_MAX = 10_000

# Runs when the query is cancelled, after the interrupt; must not block.
_cancel_hook: contextvars.ContextVar[Callable[[], None] | None] = contextvars.ContextVar("cancel_hook", default=None)

_lock = threading.Lock()
_running: dict[str, tuple[str, duckdb.DuckDBPyConnection, Callable[[], None] | None]] = {}
# Oldest first, so expiry and the cap both drop from the front.
_cancelled_early: OrderedDict[str, tuple[str, float]] = OrderedDict()
# Running queries already interrupted. DuckDB's interrupt only stops the
# statement in flight: one landing between two statements of a script is lost,
# and the next statement would run to its end.
_interrupted: set[str] = set()


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
        _running[query_id] = (owner, con, _cancel_hook.get())
    try:
        yield
    finally:
        with _lock:
            _running.pop(query_id, None)
            _interrupted.discard(query_id)


def raise_if_cancelled() -> None:
    """Raise QueryCancelled when the current request's query was cancelled before
    it started — for a wait (the pooled connection's lock) to end at once rather
    than when the query it waits behind does."""
    tag = current_query.get()
    if tag is None:
        return
    with _lock:
        early = _cancelled_early.get(tag[0])
        if early is not None and early[0] == tag[1]:
            del _cancelled_early[tag[0]]
            raise QueryCancelled(tag[0])


def raise_if_interrupted() -> None:
    """Between two statements of the current request's query: raise as the
    interrupt would have, had it landed on a statement."""
    tag = current_query.get()
    if tag is None:
        return
    with _lock:
        if tag[0] in _interrupted:
            raise duckdb.InterruptException("query cancelled")


def cancel(query_id: str, owner: str) -> bool:
    """Interrupt `owner`'s query `query_id`. True when a running query was hit."""
    now = time.monotonic()
    with _lock:
        while _cancelled_early and now - next(iter(_cancelled_early.values()))[1] > _EARLY_CANCEL_TTL_S:
            _cancelled_early.popitem(last=False)
        entry = _running.get(query_id)
        if entry is None:
            _cancelled_early[query_id] = (owner, now)
            _cancelled_early.move_to_end(query_id)
            while len(_cancelled_early) > _EARLY_CANCEL_MAX:
                _cancelled_early.popitem(last=False)
            return False
        if entry[0] != owner:
            return False
        # Under the lock: once released, the query could finish and the pooled
        # connection start another request's query, which would be interrupted.
        try:
            entry[1].interrupt()
        except Exception:  # a query finishing as we interrupt is fine
            return False
        _interrupted.add(query_id)
        hook = entry[2]
    # Outside it: the hook reaches another database, and must not hold up every
    # query starting or stopping meanwhile.
    if hook is not None:
        hook()
    return True


def progress(query_id: str, owner: str) -> float | None:
    """How much of its data `owner`'s running query `query_id` has read, in
    percent; None when it is not running or DuckDB cannot tell.

    DuckDB counts the rows its scans have read, not the work left: a query that
    ends on a big aggregation sits at its last figure meanwhile. And a query an
    external database computes (pushed down) reads nothing DuckDB can count, so
    it stays at 0 — reported as None, not as a query stuck at its start.
    """
    with _lock:
        entry = _running.get(query_id)
        if entry is None or entry[0] != owner:
            return None
        try:
            value = entry[1].query_progress()
        except Exception:  # the query finishing as we read is fine
            return None
    return value if value > 0 else None


@contextlib.contextmanager
def on_cancel(hook: Callable[[], None]) -> Iterator[None]:
    """Also call `hook` if the query `tracking` runs within this block is cancelled."""
    token = _cancel_hook.set(hook)
    try:
        yield
    finally:
        _cancel_hook.reset(token)
