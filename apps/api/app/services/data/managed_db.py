"""Writable DuckDB files owned by the server ("managed" data sources).

Uploaded files live in the content-addressed blob store and are ATTACHed
READ_ONLY: right for a source you only read. A pipeline target is the opposite —
it starts empty from a schema's DDL and every ETL script writes into it, so it
needs a stable, mutable file of its own. That is what this module owns:
``data_dir/_databases/<source_id>.duckdb``.
"""

from __future__ import annotations

import os
import re
import threading
from collections.abc import Callable
from pathlib import Path

import duckdb

from app.config import settings

# A managed file is named after the source id, which reaches here from the API
# layer and becomes a filesystem path — so it is validated rather than trusted.
#
# Not as a UUID, though it usually is one: a database imported from a workspace
# or installed from the catalog keeps the readable slug its repo declares
# (`mimic-iv-demo`) as its primary key, so requiring a UUID made every managed
# operation on such a source raise, surfacing as a 500 on /schema and friends.
#
# The check that matters is that the id cannot escape the directory or collide
# with another: lowercase alphanumerics, dash and underscore only. Lowercase is
# what rules out the case-insensitive-filesystem collision (`abc`/`ABC` → same
# file on macOS) that motivated the original UUID rule; every id the app mints
# (UUID or slugified entityId) is already lowercase.
_SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,127}$")

# DuckDB has no ADD CONSTRAINT; the OMOP DDL is full of foreign keys.
_ALTER_TABLE = re.compile(r"^\s*ALTER\s+TABLE\s", re.IGNORECASE)


def _databases_dir() -> Path:
    d = settings.data_path / "_databases"
    d.mkdir(parents=True, exist_ok=True)
    return d


def path_for(source_id: str) -> Path:
    """Filesystem path of a managed database (may not exist yet)."""
    if not isinstance(source_id, str) or not _SAFE_ID.match(source_id):
        raise ValueError(f"invalid data source id: {source_id!r}")
    return _databases_dir() / f"{source_id}.duckdb"


def exists(source_id: str) -> bool:
    return path_for(source_id).exists()


def create_from_ddl(source_id: str, ddl: str) -> str:
    """Create the managed file and run `ddl` in it. Returns the path.

    Recreates from scratch if a file is already there, so retrying a failed
    creation cannot leave half a schema behind.
    """
    path = path_for(source_id)
    if path.exists():
        path.unlink()

    skipped: list[str] = []
    con = duckdb.connect(str(path))
    try:
        con.execute(f"SET extension_directory = '{_ext_dir()}'")
        # Statement by statement, so a failure names the statement that broke
        # rather than the whole batch. ALTER TABLE is skipped the same way the
        # browser path does: the OMOP DDL ends with ~176 `ADD CONSTRAINT ...
        # FOREIGN KEY` statements, which DuckDB rejects ("No support for that
        # ALTER TABLE option yet"). The tables themselves are what matter here;
        # referential constraints are not enforced on either side.
        for stmt in _split(ddl):
            if _ALTER_TABLE.match(stmt):
                skipped.append(stmt)
                continue
            con.execute(stmt)
    except Exception:
        con.close()
        path.unlink(missing_ok=True)
        raise
    else:
        con.close()
    return str(path)


def delete(source_id: str) -> None:
    path_for(source_id).unlink(missing_ok=True)


def data_size(source_id: str) -> int | None:
    """Bytes the data in a managed file actually occupies, or None if unknown.

    The file's size on disk is NOT this number: free blocks are counted there and
    are exactly what compaction drops. Used as the denominator for compaction
    progress, where dividing by the file size would stall the bar at 19% and then
    jump to 100% on a file that is mostly free space.

    `used_blocks * block_size` is DuckDB's own accounting, so it tracks the copy
    closely but is not a guarantee — the caller must tolerate the final figure
    landing slightly either side of it.
    """
    path = path_for(source_id)
    if not path.exists():
        return None
    con = duckdb.connect()
    try:
        con.execute(f"ATTACH '{_sql_literal(str(path))}' AS m (READ_ONLY)")
        row = con.execute(
            "SELECT used_blocks * block_size FROM pragma_database_size() "
            "WHERE database_name = 'm'"
        ).fetchone()
        con.execute("DETACH m")
        return int(row[0]) if row and row[0] is not None else None
    except Exception:  # noqa: BLE001 — progress is best-effort, never fatal
        return None
    finally:
        con.close()


def compact(
    source_id: str, on_bytes: Callable[[int], None] | None = None
) -> tuple[int, int]:
    """Rewrite the managed file without its free blocks. Returns (before, after).

    A DuckDB file is a set of fixed-size blocks. Dropping a table frees its
    blocks, but a checkpoint can only hand space back by truncating the END of
    the file: free blocks with live data written after them stay where they are.
    An ETL that rebuilds its tables on every run leaves exactly that shape, and
    the file ends up many times the size of the data in it (an OMOP target
    measured here: 62 GB of file for 11.6 GB of data). Those blocks ARE reused by
    later runs, so this is a one-off reclaim rather than a leak — but nothing
    short of a rewrite closes the holes.

    `VACUUM` does not do it (DuckDB's is a statistics no-op) and `VACUUM FULL` is
    not implemented. `COPY FROM DATABASE` into a fresh file is the supported way:
    it replays schema + data, so the copy has only the blocks it needs.

    Written to a sibling temp file and swapped in with `os.replace`, which is
    atomic on the same filesystem: an interrupted compaction leaves the original
    untouched rather than a half-written database. The caller MUST evict the
    connection pool first: the swap replaces the inode, and a warm handle would
    go on serving the file that was replaced.

    `on_bytes` is called with the temp file's size roughly once a second. The copy
    is a single statement, so DuckDB reports nothing during it — but the bytes it
    has written grow monotonically and near-linearly (measured: 24/46/66/87% at
    one-second intervals), which is enough to drive a progress readout.
    """
    path = path_for(source_id)
    if not path.exists():
        raise ValueError("the database file is missing")

    before = path.stat().st_size
    # Same directory, so os.replace stays atomic and the copy cannot land on a
    # filesystem too small for it when the data dir is a dedicated volume.
    tmp = path.with_name(f"{path.stem}.compacting-{os.getpid()}.duckdb")
    tmp.unlink(missing_ok=True)

    stop = threading.Event()
    watcher: threading.Thread | None = None
    if on_bytes is not None:
        def _watch() -> None:
            while not stop.wait(1.0):
                try:
                    on_bytes(tmp.stat().st_size)
                except OSError:
                    # The temp file is gone (finished or failed): the next loop
                    # exits on the event anyway.
                    pass

        watcher = threading.Thread(target=_watch, daemon=True)
        watcher.start()

    con = duckdb.connect()
    try:
        con.execute(f"SET extension_directory = '{_ext_dir()}'")
        con.execute(f"ATTACH '{_sql_literal(str(path))}' AS src (READ_ONLY)")
        con.execute(f"ATTACH '{_sql_literal(str(tmp))}' AS dst")
        con.execute("COPY FROM DATABASE src TO dst")
        con.execute("DETACH dst")
        con.execute("DETACH src")
    except Exception:
        con.close()
        tmp.unlink(missing_ok=True)
        raise
    finally:
        stop.set()
        if watcher is not None:
            watcher.join(timeout=2)
    con.close()

    os.replace(tmp, path)
    return before, path.stat().st_size


def _sql_literal(value: str) -> str:
    """Escape a path for the single-quoted SQL literal it is interpolated into."""
    return value.replace("'", "''")


def _ext_dir() -> str:
    d = settings.data_path / "_duckdb_ext"
    d.mkdir(parents=True, exist_ok=True)
    # Escaped for the single-quoted SQL literal it is interpolated into. The path
    # is operator config, not user input, but a data dir with a quote in it would
    # otherwise break the statement.
    return str(d).replace("'", "''")


def _split(sql: str) -> list[str]:
    """Split on semicolons that are not inside a string literal or a comment."""
    out: list[str] = []
    buf: list[str] = []
    i = 0
    quote: str | None = None
    while i < len(sql):
        ch = sql[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                if i + 1 < len(sql) and sql[i + 1] == quote:
                    buf.append(sql[i + 1])
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == "-" and sql[i + 1 : i + 2] == "-":
            end = sql.find("\n", i)
            i = len(sql) if end == -1 else end
            continue
        if ch == "/" and sql[i + 1 : i + 2] == "*":
            end = sql.find("*/", i + 2)
            i = len(sql) if end == -1 else end + 2
            continue
        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out
