"""Writable DuckDB files owned by the server ("managed" data sources).

Uploaded files live in the content-addressed blob store and are ATTACHed
READ_ONLY: right for a source you only read. A pipeline target is the opposite —
it starts empty from a schema's DDL and every ETL script writes into it, so it
needs a stable, mutable file of its own. That is what this module owns:
``data_dir/_databases/<source_id>.duckdb``.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

import duckdb

from app.config import settings

# A managed file is named after the source id. It is a UUID everywhere in the
# app; validate it as one rather than trust it, because it reaches here from the
# API layer and becomes a filesystem path. A strict UUID also rules out the
# case-insensitive-filesystem collision a loose hex pattern allowed (`abc`/`ABC`
# → same file on macOS).

# DuckDB has no ADD CONSTRAINT; the OMOP DDL is full of foreign keys.
_ALTER_TABLE = re.compile(r"^\s*ALTER\s+TABLE\s", re.IGNORECASE)


def _databases_dir() -> Path:
    d = settings.data_path / "_databases"
    d.mkdir(parents=True, exist_ok=True)
    return d


def path_for(source_id: str) -> Path:
    """Filesystem path of a managed database (may not exist yet)."""
    try:
        canonical = str(uuid.UUID(str(source_id)))
    except (ValueError, AttributeError, TypeError) as exc:
        raise ValueError(f"invalid data source id: {source_id!r}") from exc
    return _databases_dir() / f"{canonical}.duckdb"


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
