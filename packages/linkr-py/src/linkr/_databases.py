import os
from typing import TYPE_CHECKING

from ._api import LinkrError, api_call, find_database

if TYPE_CHECKING:
    import duckdb


def _duckdb():
    """Resolve duckdb at call time, not at import time.

    ``import linkr`` must work in a project environment that declares nothing — the
    path helpers need no dependency at all, and a top-level ``import duckdb`` made
    the whole package unimportable there, so ``linkr.scripts_dir()`` failed with
    "No module named 'duckdb'". Mirrors the R client, whose DBI/duckdb are Suggests
    resolved on use (see linkr-r/R/zzz.R).
    """
    try:
        import duckdb
    except ModuleNotFoundError as e:
        raise LinkrError(
            "Opening a database needs the 'duckdb' package, which this project's "
            "environment does not have. Add it in the Environments manager."
        ) from e
    return duckdb


def databases() -> list[dict]:
    """The databases this project can query.

    Lists what the acting user may read — the same set the Databases page shows,
    resolved server-side, so a script never hardcodes a path.

    The ``dialect`` field, not ``engine``, says which SQL to write: PostgreSQL and
    MySQL are reached by attaching them into DuckDB exactly as the app's own SQL
    editor does, so a query moves between the IDE and the app unchanged.

    A source whose file was never uploaded is listed with ``connectable`` False:
    visible, but :func:`connect` on it will fail.
    """
    return [
        {
            "id": row.get("id"),
            "name": row.get("name"),
            "engine": row.get("engine"),
            "dialect": row.get("dialect"),
            "kind": row.get("kind"),
            "connectable": bool(row.get("connectable")),
        }
        for row in api_call("/databases")
    ]


def connect(name: str, read_only: bool = True) -> "duckdb.DuckDBPyConnection":
    """Open one of this project's databases.

    Returns a real DuckDB connection — a DBAPI handle — so ``.execute()``,
    ``.df()``, pandas' ``read_sql`` and anything else built on it work.

    A managed or uploaded file is opened directly; a Parquet source is registered
    as one view per table; PostgreSQL and MySQL are ATTACHed read-only, which is
    how the app itself reaches them. The SQL is DuckDB's in every case, so a query
    moves between the IDE and the app's SQL editor unchanged, and a live table can
    be joined against a local Parquet file in one statement.

    Nothing is cached between calls. DuckDB refuses to open the same file twice in
    one process, so a hidden shared connection would surface later as a "Unique
    file handle conflict" that no restart fixes. Close what you open, or use the
    connection as a context manager.

    :param name: Database name or id, as listed by :func:`databases`.
    :param read_only: Passed through for file-backed sources. External databases
        are always attached read-only: a script must not write to a source.
    """
    if not isinstance(name, str) or not name:
        raise LinkrError("`name` must be a database name or id.")
    db = find_database(api_call("/databases"), name)
    if not db.get("connectable"):
        raise LinkrError(
            f"Database {db.get('name')!r} cannot be opened: no data has been "
            "uploaded or built for it yet."
        )
    dialect = db.get("dialect") or "duckdb"
    if dialect != "duckdb":
        raise LinkrError(
            f"Database {db.get('name')!r} speaks the {dialect!r} dialect, which "
            "this version of the linkr package cannot open."
        )

    kind = db.get("kind")
    if kind in ("managed", "file"):
        return _duckdb().connect(db["path"], read_only=read_only)
    if kind == "parquet-folder":
        return _open_parquet(db.get("tables") or [])
    if kind == "external":
        return _open_external(db)
    raise LinkrError(f"Unsupported database kind: {kind}")


def _open_parquet(tables: list[dict]) -> "duckdb.DuckDBPyConnection":
    con = _duckdb().connect()
    try:
        for entry in tables:
            paths = ", ".join(_quote(p) for p in entry["paths"])
            con.execute(
                f'CREATE OR REPLACE VIEW "{entry["table"]}" AS '
                f"SELECT * FROM read_parquet([{paths}])"
            )
    except Exception:
        con.close()
        raise
    return con


def _open_external(db: dict) -> "duckdb.DuckDBPyConnection":
    con = _duckdb().connect()
    try:
        attach_type = db["attachType"]
        _use_server_extensions(con)
        con.execute(f"INSTALL {attach_type}")
        con.execute(f"LOAD {attach_type}")
        con.execute(
            f"ATTACH {_quote(db['attachDsn'])} AS ext (TYPE {attach_type}, READ_ONLY)"
        )
        # The source's schema goes on the search path so bare table names resolve
        # the way they do in the app's SQL editor.
        con.execute(f"SET search_path = 'memory,ext.{db['attachScope']}'")
    except Exception:
        con.close()
        raise
    return con


def _use_server_extensions(con: "duckdb.DuckDBPyConnection") -> None:
    """Read DuckDB extensions from the server's directory rather than downloading
    them per session — which would also fail outright on an air-gapped instance."""
    ext_dir = os.environ.get("LINKR_DUCKDB_EXTENSIONS", "")
    if ext_dir:
        con.execute(f"SET extension_directory = {_quote(ext_dir)}")


def _quote(value: str) -> str:
    """A single-quoted SQL literal, doubling any quote the value contains."""
    return "'" + str(value).replace("'", "''") + "'"
