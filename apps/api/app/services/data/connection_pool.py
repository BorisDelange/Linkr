"""A tiny pool of long-lived DuckDB connections, keyed by data source.

Why this exists: every external-DB query used to open a fresh DuckDB connection,
``INSTALL``/``LOAD`` the postgres/mysql extension (~150 ms) and re-``ATTACH`` the
remote database (a full network handshake) before running a single statement.
A page like Warehouse → Concepts fires many small queries (filter options, the
paged table + count, per-row stats), so that fixed cost dominated wall-clock.

Here we keep one live DuckDB connection per source (extension already loaded,
remote database already ATTACHed) and reuse it across requests. Only the first
query on a source pays the setup cost; the rest reuse the warm connection.

Threading: queries run in the FastAPI threadpool (``asyncio.to_thread``), so
several threads may reach the pool at once. A DuckDBPyConnection is NOT safe for
concurrent use, so each pooled entry carries its own lock and all use of that
connection is serialised through it. A separate registry lock guards the dict of
entries. Idle connections past ``pool_ttl_seconds`` are closed lazily on the next
access and swept opportunistically.

Security: the (decrypted) credentials live inside the ATTACHed connection for as
long as it stays warm — the same trust boundary as the request that opened it.
``invalidate(key)`` drops a source's connection on update/delete so a changed
password or host never keeps serving through a stale handle.
"""

import threading
import time
from collections.abc import Callable

import duckdb

from app.config import settings


class _Entry:
    __slots__ = ("con", "lock", "last_used")

    def __init__(self, con: duckdb.DuckDBPyConnection):
        self.con = con
        self.lock = threading.Lock()
        self.last_used = time.monotonic()


_registry: dict[str, _Entry] = {}
_registry_lock = threading.Lock()


def _ttl_seconds() -> float:
    return float(getattr(settings, "pool_ttl_seconds", 300))


def _sweep_locked(now: float) -> None:
    """Close and drop idle entries. Caller holds `_registry_lock`. An entry whose
    lock is currently held (a query is running) is skipped — never close a
    connection out from under an in-flight query."""
    ttl = _ttl_seconds()
    for key in list(_registry):
        entry = _registry[key]
        if now - entry.last_used <= ttl:
            continue
        if not entry.lock.acquire(blocking=False):
            continue
        try:
            _close_quietly(entry.con)
            del _registry[key]
        finally:
            entry.lock.release()


def _close_quietly(con: duckdb.DuckDBPyConnection) -> None:
    try:
        con.close()
    except Exception:  # noqa: BLE001 — a dead connection is fine to forget
        pass


def run_pooled(
    key: str,
    setup: Callable[[], duckdb.DuckDBPyConnection],
    use: Callable[[duckdb.DuckDBPyConnection], list[dict]],
) -> list[dict]:
    """Run `use` against the warm connection for `key`, establishing it via
    `setup` on first use. `setup` must return a fully-ready connection (extension
    loaded, source ATTACHed). Use of the connection is serialised per key.

    If the warm connection raises (e.g. the remote dropped it), it is discarded
    and the call retried once with a fresh `setup` — so a stale handle self-heals
    instead of failing the request."""
    now = time.monotonic()
    with _registry_lock:
        _sweep_locked(now)
        entry = _registry.get(key)
        if entry is None:
            entry = _Entry(setup())
            _registry[key] = entry

    with entry.lock:
        entry.last_used = time.monotonic()
        try:
            return use(entry.con)
        except (duckdb.ConnectionException, duckdb.IOException):
            _close_quietly(entry.con)
            with _registry_lock:
                # Only drop if it's still the same entry (another thread may have
                # already replaced it).
                if _registry.get(key) is entry:
                    del _registry[key]
            # Rebuild once, outside the dead entry's lifecycle.
            fresh = setup()
            with _registry_lock:
                new_entry = _Entry(fresh)
                _registry[key] = new_entry
            with new_entry.lock:
                new_entry.last_used = time.monotonic()
                return use(new_entry.con)


def invalidate(key: str) -> None:
    """Drop a source's warm connection (call on source update/delete). Waits for
    any in-flight query on it to finish before closing."""
    with _registry_lock:
        entry = _registry.pop(key, None)
    if entry is None:
        return
    with entry.lock:
        _close_quietly(entry.con)


def clear() -> None:
    """Close every pooled connection (shutdown / tests)."""
    with _registry_lock:
        entries = list(_registry.values())
        _registry.clear()
    for entry in entries:
        with entry.lock:
            _close_quietly(entry.con)
