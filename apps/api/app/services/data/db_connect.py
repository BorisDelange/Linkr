"""Server-side connection to external SQL databases (PostgreSQL, MySQL).

Uses DuckDB's ``postgres`` / ``mysql`` extensions to ATTACH a live database
read-only, introspect its schema and run SQL — the same DuckDB SQL dialect the
whole app already speaks, so no per-engine query rewriting and no extra hard
dependency (DuckDB is already required). The password is passed in per call and
never stored: it lives only for the duration of the connection.
"""

import datetime
import os
import re
import tempfile
import threading
import uuid
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path

import duckdb

from app.config import settings
from app.services.data import connection_pool, file_reader

_ATTACH_ALIAS = "ext"

# Safety cap on rows returned to the browser. The UI paginates/displays far less;
# an uncapped SELECT * on a huge table would otherwise overwhelm the response.
MAX_QUERY_ROWS = 10_000

# Per-engine wiring: the DuckDB extension, the ATTACH TYPE, and the passthrough
# query function used to read the source's own information_schema.
_ENGINES = {
    "postgresql": {"extension": "postgres", "type": "postgres", "query_fn": "postgres_query"},
    "mysql": {"extension": "mysql", "type": "mysql", "query_fn": "mysql_query"},
}


def _engine_spec(config: dict) -> dict:
    engine = config.get("engine")
    spec = _ENGINES.get(engine)
    if spec is None:
        raise ValueError(f"unsupported engine for server-side connection: {engine}")
    return spec


def _ext_dir() -> str:
    d = settings.data_path / "_duckdb_ext"
    d.mkdir(parents=True, exist_ok=True)
    return d.as_posix()


# A DuckDB catalog / schema / table identifier we are willing to interpolate
# into SQL. Role names come from client `roles` keys and table names from
# uploaded Parquet filenames, so both are untrusted and must match this before
# being quoted into ATTACH / CREATE VIEW.
# re.ASCII, because IGNORECASE on a str pattern enables Unicode case-folding:
# `[a-z]` then also matches İ (U+0130), ı (U+0131), ſ (U+017F) and K (U+212A).
# None of them can break out of the quoting, so this was never an injection
# vector — but a name could validate here and not round-trip under DuckDB's own
# case-insensitive matching.
_SAFE_IDENT = re.compile(r"[a-z_][a-z0-9_]*", re.IGNORECASE | re.ASCII)


def _require_ident(value: str, what: str) -> str:
    if not isinstance(value, str) or _SAFE_IDENT.fullmatch(value) is None:
        raise ValueError(f"invalid {what}: {value!r}")
    return value


def _sql_path(path: str) -> str:
    """A filesystem path escaped for a single-quoted SQL literal."""
    return str(path).replace("'", "''")


def _lock_down_user_sql(con: duckdb.DuckDBPyConnection) -> None:
    """Harden a DuckDB connection that is about to run arbitrary client SQL:
    forbid auto-installing/loading unknown or community extensions, then lock the
    configuration so the query can't turn any of it back on. Call this AFTER any
    legitimately-needed extension (e.g. excel) has already been loaded and the
    source view created."""
    con.execute("SET autoinstall_known_extensions=false")
    con.execute("SET autoload_known_extensions=false")
    con.execute("SET allow_community_extensions=false")
    con.execute("SET lock_configuration=true")


def _connect(extension: str) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    # Persist installed extensions under data_dir so INSTALL only hits the
    # network once (and can be pre-warmed at build time in an offline image).
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    con.execute(f"INSTALL {extension}")
    con.execute(f"LOAD {extension}")
    return con


def _dsn_value(value: str) -> str:
    """Escape a libpq/MySQL DSN value so it stays a single opaque token.

    DuckDB's postgres/mysql ATTACH parser does NOT understand libpq's
    ``key="value"`` double-quoting — it would take the quotes as literal
    characters of the value (``host="localhost"`` → it tries to resolve the host
    name ``"localhost"``, quotes included, and fails). What it does honour is
    libpq's backslash escaping: any character can be escaped with ``\\``, so we
    backslash-escape the delimiters (space, backslash) and the single quote.

    Single quotes matter because the whole DSN is later wrapped in a
    single-quoted SQL literal (``ATTACH '<dsn>' ...``); a raw single quote in a
    value would otherwise interact with that literal.

    Without this, an attacker-controlled field (e.g. a `username` of
    ``x password=secret host=evil``) would inject extra DSN keywords and could
    redirect the connection or smuggle parameters. libpq treats ANY whitespace
    (space, tab, newline, carriage return, form-feed, vertical tab) as a token
    separator, so every whitespace char must be backslash-escaped — not just the
    space — to keep each value one token and prevent an injected ``key=value``
    pair from breaking out.
    """
    escaped = (
        str(value)
        .replace("\\", "\\\\")
        .replace("'", "\\'")
    )
    return re.sub(r"\s", lambda m: "\\" + m.group(0), escaped)


def _dsn(config: dict, password: str | None) -> str:
    """Build a key=value DSN. Both the libpq (Postgres) and MySQL ATTACH strings
    accept host/port/user/password; the database key differs (dbname vs database).
    Every client-controlled value is quoted (see _dsn_value)."""
    is_mysql = config.get("engine") == "mysql"
    parts: list[str] = []
    if host := config.get("host"):
        parts.append(f"host={_dsn_value(host)}")
    if port := config.get("port"):
        parts.append(f"port={int(port)}")
    if database := config.get("database"):
        key = "database" if is_mysql else "dbname"
        parts.append(f"{key}={_dsn_value(database)}")
    if username := config.get("username"):
        parts.append(f"user={_dsn_value(username)}")
    if password:
        parts.append(f"password={_dsn_value(password)}")
    return " ".join(parts)


def _scope(config: dict) -> str:
    """The schema (Postgres) or database (MySQL) whose tables we expose. Validated
    as a plain identifier since it is interpolated into SQL below."""
    is_mysql = config.get("engine") == "mysql"
    scope = config.get("schema") or config.get("database") if is_mysql else config.get("schema")
    scope = scope or ("mysql" if is_mysql else "public")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", scope):
        raise ValueError(f"invalid schema/database name: {scope!r}")
    return scope


def _attach(con: duckdb.DuckDBPyConnection, config: dict, password: str | None) -> None:
    spec = _engine_spec(config)
    dsn = _dsn(config, password)
    # The DSN goes into a single-quoted SQL literal; double any single quote a
    # value may still legitimately contain (e.g. a password) so it can't close it.
    dsn_literal = dsn.replace("'", "''")
    con.execute(
        f"ATTACH '{dsn_literal}' AS {_ATTACH_ALIAS} (TYPE {spec['type']}, READ_ONLY)"
    )


def _row_to_json(row: dict) -> dict:
    out: dict = {}
    for k, v in row.items():
        if isinstance(v, (datetime.date, datetime.datetime)):
            out[k] = v.isoformat()
        elif isinstance(v, Decimal):
            out[k] = float(v)
        else:
            out[k] = v
    return out


def _dollar_tag(sql: str, at: int) -> str | None:
    """The dollar-quote tag opening at `at` (`$$` or `$name$`), or None.

    A tag is `$` + optional identifier + `$`, and the identifier may not start
    with a digit (`$1` is a parameter, not a tag)."""
    if sql[at] != "$":
        return None
    j = at + 1
    while j < len(sql) and (sql[j].isalnum() or sql[j] == "_"):
        if j == at + 1 and sql[j].isdigit():
            return None
        j += 1
    return sql[at:j + 1] if j < len(sql) and sql[j] == "$" else None


def _strip_leading_noise(stmt: str) -> str:
    """A statement without the comments and blank space in front of its first
    keyword, so a check anchored on that keyword cannot be dodged by prefixing
    one. `/* x */ INSTALL httpfs` reads as `INSTALL httpfs`."""
    i = 0
    n = len(stmt)
    while i < n:
        if stmt[i].isspace():
            i += 1
        elif stmt.startswith("--", i):
            nl = stmt.find("\n", i)
            i = n if nl == -1 else nl + 1
        elif stmt.startswith("/*", i):
            end = stmt.find("*/", i + 2)
            i = n if end == -1 else end + 2
        else:
            break
    return stmt[i:]


def _split_statements(sql: str) -> list[str]:
    """Split SQL on top-level semicolons — those not inside a string, a quoted
    identifier, a comment or a dollar-quoted block.

    Mirrors the frontend's splitSqlStatements (lib/duckdb/sql-tokenizer.ts) so
    multi-statement scripts behave the same in both engines. Block comments and
    dollar quotes are part of that contract, not a detail: without them a `;`
    inside `/* ... */` or `$$ ... $$` cuts a statement in half, and a leading
    block comment hides the statement's first keyword from
    `_reject_forbidden_statements` — which is how `/* x */ INSTALL httpfs`
    slipped past the extension guard.

    An unterminated region runs to end-of-input rather than being dropped, so the
    rest of the script is never silently treated as executable structure."""
    stmts: list[str] = []
    current = ""
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        if ch == "-" and i + 1 < n and sql[i + 1] == "-":
            nl = sql.find("\n", i)
            stop = n if nl == -1 else nl + 1
            current += sql[i:stop]
            i = stop
        elif ch == "/" and i + 1 < n and sql[i + 1] == "*":
            end = sql.find("*/", i + 2)
            stop = n if end == -1 else end + 2
            current += sql[i:stop]
            i = stop
        elif ch == "$" and (tag := _dollar_tag(sql, i)) is not None:
            close = sql.find(tag, i + len(tag))
            stop = n if close == -1 else close + len(tag)
            current += sql[i:stop]
            i = stop
        elif ch in ("'", '"', "`"):
            j = i + 1
            while j < n:
                # Backslash escapes the next char inside a single-quoted run
                # (DuckDB's E'...\'...'), so it does not end the literal early.
                if ch == "'" and sql[j] == "\\" and j + 1 < n:
                    j += 2
                    continue
                if sql[j] == ch:
                    if j + 1 < n and sql[j + 1] == ch:
                        j += 2
                        continue
                    break
                j += 1
            stop = n if j >= n else j + 1
            current += sql[i:stop]
            i = stop
        elif ch == ";":
            if current.strip():
                stmts.append(current.strip())
            current = ""
            i += 1
        else:
            current += ch
            i += 1
    if current.strip():
        stmts.append(current.strip())
    return stmts


# Statements a user script may never run. `enable_external_access` is the real
# filesystem/network gate, but it can only be set at connect time and must stay ON
# whenever a legitimate role reads Parquet files or a mapping CSV — which is the
# NORMAL pipeline shape, not an edge case. In that state `_lock_down_user_sql` is
# not enough on its own: it only disables AUTO-install/load, so an explicit
# `INSTALL httpfs; LOAD httpfs` still succeeded and handed the script outbound
# network access. DuckDB's `allowed_directories` cannot help either — it is
# refused before startup and, after it, only enforced while external access is
# disabled. So the extension surface is closed here instead.
#
# ATTACH is included because it opens arbitrary database files (and would also
# collide with the role attaches the runner owns); the roles it legitimately needs
# are attached by the server before the script runs.
_FORBIDDEN_IN_USER_SQL = re.compile(
    r"^\s*(?:FORCE\s+)?(INSTALL|LOAD|ATTACH)\b", re.IGNORECASE
)


def _reject_forbidden_statements(sql: str) -> None:
    """Raise when a user script contains a statement it must never run.

    Checked per split statement, with whatever comments precede the first keyword
    stripped: the pattern is anchored, so `/* x */ INSTALL httpfs` would otherwise
    not match and the extension guard could be dodged with a two-character prefix.

    The splitter keeps string literals intact, so `SELECT '-- install httpfs'` is
    still not a false positive."""
    for stmt in _split_statements(sql):
        m = _FORBIDDEN_IN_USER_SQL.match(_strip_leading_noise(stmt))
        if m:
            raise ValueError(f"{m.group(1).upper()} is not allowed in a pipeline script")


def _run_statements(
    con: duckdb.DuckDBPyConnection, search_path: str, sql: str,
    max_rows: int | None = MAX_QUERY_ROWS,
    on_statement: Callable[[int, int, str], None] | None = None,
) -> list[dict]:
    """Execute each statement in `sql` sequentially, returning the last result's
    rows. `search_path` puts DuckDB's writable `memory` catalog first (so CREATE
    VIEW / temp tables land there) then the read-only attached source for reads.

    `max_rows` caps the payload (a `SELECT *` on a billion-row table would blow
    up the response). Pass `None` for internal server-side consumers that need
    the full result (e.g. materializing the cross-project table cache).

    `on_statement(index, total, sql)` is called BEFORE each statement runs, so a
    caller can report progress. Every statement shares this one connection, which
    is what lets a script carry `SET VARIABLE` or a temp table from one statement
    to the next — splitting the script across requests loses that."""
    con.execute(f"SET search_path='{search_path}'")
    result: duckdb.DuckDBPyConnection | None = None
    statements = _split_statements(sql)
    for i, stmt in enumerate(statements):
        if on_statement is not None:
            on_statement(i, len(statements), stmt)
        result = con.execute(stmt)
    if result is None or result.description is None:
        return []
    names = [d[0] for d in result.description]
    rows = result.fetchall() if max_rows is None else result.fetchmany(max_rows)
    return [_row_to_json(dict(zip(names, row))) for row in rows]


def query_external(
    config: dict, password: str | None, sql: str, pool_key: str | None = None
) -> list[dict]:
    """Run SQL against the attached source and return rows as dicts.

    Bare table names (``FROM patients``) resolve to the source via search_path,
    matching the DuckDB-WASM path. The source is attached read-only; CREATE VIEW
    / temp tables land in DuckDB's local `memory` catalog (writable), so
    multi-statement scripts work. Date/time values come back as ISO strings.

    When `pool_key` is given, the connection (extension loaded + source ATTACHed)
    is kept warm and reused across calls (connection_pool) — the setup cost
    (~150 ms + the remote handshake) is then paid only on the first query.
    `search_path` is re-set on every call, so reuse is safe. Without a key the
    connection is opened and closed per call (used by one-shot paths like
    test_connection, where reuse would defeat the point).
    """
    spec = _engine_spec(config)
    scope = _scope(config)
    search_path = f"memory,{_ATTACH_ALIAS}.{scope}"

    def _setup() -> duckdb.DuckDBPyConnection:
        con = _connect(spec["extension"])
        _attach(con, config, password)
        return con

    if pool_key is None:
        con = _setup()
        try:
            return _run_statements(con, search_path, sql)
        finally:
            con.close()

    return connection_pool.run_pooled(
        pool_key,
        _setup,
        lambda con: _run_statements(con, search_path, sql),
    )


def _attach_file(con: duckdb.DuckDBPyConnection, engine: str, path: str) -> None:
    """ATTACH a local database file read-only. DuckDB files attach natively;
    SQLite needs the sqlite extension."""
    if engine == "sqlite":
        con.execute("INSTALL sqlite")
        con.execute("LOAD sqlite")
        con.execute(f"ATTACH '{path}' AS {_ATTACH_ALIAS} (TYPE sqlite, READ_ONLY)")
    else:  # duckdb
        con.execute(f"ATTACH '{path}' AS {_ATTACH_ALIAS} (READ_ONLY)")


def query_file(
    engine: str, path: str, sql: str, pool_key: str | None = None
) -> list[dict]:
    """Run SQL against a local DuckDB/SQLite file (server-side). Read-only file;
    CREATE VIEW / temp tables land in the writable `memory` catalog. With
    `pool_key`, the ATTACHed connection is kept warm across calls."""
    search_path = f"memory,{_ATTACH_ALIAS}"

    def _setup() -> duckdb.DuckDBPyConnection:
        con = duckdb.connect()
        con.execute(f"SET extension_directory = '{_ext_dir()}'")
        _attach_file(con, engine, path)
        return con

    if pool_key is None:
        con = _setup()
        try:
            return _run_statements(con, search_path, sql)
        finally:
            con.close()

    return connection_pool.run_pooled(
        pool_key, _setup, lambda con: _run_statements(con, search_path, sql)
    )


def query_file_source(
    path: str,
    file_name: str | None,
    parse_options: dict | None,
    select_sql: str,
    dedup_partition: str,
    sql: str,
    max_rows: int | None = MAX_QUERY_ROWS,
) -> list[dict]:
    """Run SQL over a mapping project's file source blob (CSV/Parquet/Excel).

    `select_sql` is the column-normalizing projection (built from the project's
    columnMapping, mirroring the DuckDB-WASM mount) that becomes the view
    ``source_concepts`` — the table name the frontend's SQL references. The read
    expression (reader + sheet/delimiter options + Excel extension) is built by
    the shared `file_reader.build_read_expr`, the same one dataset import uses.
    """
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    try:
        reader = file_reader.build_read_expr(
            con, path, file_name, parse_options or {}, nullstr="NA"
        )
        # Raw (pre-dedup) projection, then the deduped view the frontend queries.
        # Keeping the raw one lets the editor count dropped duplicates via
        # `COUNT(*) FROM source_concepts_raw - COUNT(*) FROM source_concepts`,
        # mirroring the browser mount.
        con.execute(
            f"CREATE VIEW source_concepts_raw AS SELECT {select_sql} FROM {reader}"
        )
        # Drop duplicate source concepts (same vocabulary_id + concept_code),
        # keeping the first row — mirrors the frontend mount so a CSV with
        # duplicates yields the same rows and ids on both sides.
        con.execute(
            f"CREATE VIEW source_concepts AS "
            f"SELECT * FROM source_concepts_raw "
            f"QUALIFY row_number() OVER "
            f"(PARTITION BY {dedup_partition} ORDER BY concept_id) = 1"
        )
        # The `sql` here is arbitrary client SQL (editor-authored, mirroring the
        # in-browser DuckDB-WASM path). Harden the connection before running it:
        # reject INSTALL/LOAD/ATTACH outright, block auto-loading unknown/community
        # extensions, and lock the config so the query can't re-enable anything.
        # NOTE: DuckDB 1.5 cannot confine the local filesystem once the DB is
        # running (allowed_directories can't be set at/after connect and
        # enable_external_access can't be toggled), so this does NOT sandbox
        # arbitrary local-file reads — that residual is accepted because /query is
        # now editor-only, and editors already hold ide:execute in this app. What
        # the statement check adds is the network: without it, httpfs could be
        # loaded explicitly and turn a file read into outbound egress.
        _reject_forbidden_statements(sql)
        _lock_down_user_sql(con)
        return _run_statements(con, "memory", sql, max_rows=max_rows)
    finally:
        file_reader.cleanup_transcoded(con)
        con.close()


def file_source_columns(
    path: str, file_name: str | None, parse_options: dict | None,
    preview_rows: int = 0,
) -> tuple[list[str], int, list[dict]]:
    """Column names + total row count (+ optional preview rows) of a raw file
    blob, before any project / columnMapping exists. Used to preview a file whose
    columns can't be read client-side (Parquet in server mode, or any file in
    server mode once the browser parse is removed) so the user can map them.

    Reads the schema for names (LIMIT 0) plus a COUNT(*); materializes at most
    ``preview_rows`` rows (0 = none). Keeps the mapping mount's ``nullstr='NA'``
    so a literal "NA" cell becomes NULL identically to the browser DuckDB-WASM
    path and the eventual server-side query."""
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    try:
        reader = file_reader.build_read_expr(
            con, path, file_name, parse_options or {}, nullstr="NA"
        )
        cols = [d[0] for d in con.execute(f"SELECT * FROM {reader} LIMIT 0").description]
        total = con.execute(f"SELECT COUNT(*) FROM {reader}").fetchone()[0]
        rows: list[dict] = []
        if preview_rows > 0:
            res = con.execute(f"SELECT * FROM {reader} LIMIT {int(preview_rows)}")
            names = [d[0] for d in res.description]
            rows = [_row_to_json(dict(zip(names, r))) for r in res.fetchall()]
        return cols, int(total), rows
    finally:
        file_reader.cleanup_transcoded(con)
        con.close()


def introspect_file(engine: str, path: str) -> list[dict]:
    """Tables + columns of a local DuckDB/SQLite file. Types are DuckDB-normalized
    (the file has no separate native catalog to passthrough to)."""
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    try:
        _attach_file(con, engine, path)
        rows = con.execute(
            "SELECT table_name, column_name, data_type, is_nullable "
            "FROM information_schema.columns "
            f"WHERE table_catalog = '{_ATTACH_ALIAS}' "
            "ORDER BY table_name, ordinal_position"
        ).fetchall()
    finally:
        con.close()

    tables: dict[str, list[dict]] = {}
    for table_name, column_name, data_type, is_nullable in rows:
        tables.setdefault(str(table_name), []).append(
            {
                "name": str(column_name),
                "type": str(data_type),
                "nullable": str(is_nullable).upper() == "YES",
            }
        )
    return [{"name": name, "columns": cols} for name, cols in tables.items()]


_SHARD_RE = re.compile(r"^(part|chunk|data|file)[-_.]\d+([-_.]\w+)*$|^\d+$")


def _table_of(file_name: str, known: list[str]) -> str:
    """Table name for a Parquet file, mirroring the frontend's extractTableName:
    prefer a known-table segment, else the file stem — falling back to the parent
    dir only for numbered shards (`admissions/part-00000.parquet`), where the
    directory carries the table identity."""
    parts = [p for p in file_name.replace("\\", "/").split("/") if p]
    known_set = {k.lower() for k in known}
    if known_set:
        for seg in reversed(parts):
            stem = re.sub(r"\.[^.]+$", "", seg).lower()
            if stem in known_set:
                return stem
    stem = re.sub(r"\.[^.]+$", "", parts[-1]).lower()
    if len(parts) >= 2 and _SHARD_RE.match(stem):
        return parts[-2].lower()
    return stem


def _group_parquet(files: list[tuple[str, str]], known: list[str]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for file_name, path in files:
        if not file_name.lower().endswith((".parquet", ".pq")):
            continue
        table = _table_of(file_name, known)
        # The table name is interpolated into a quoted identifier; a filename that
        # doesn't yield a plain identifier is skipped rather than risking a broken
        # (or injected) CREATE VIEW.
        if _SAFE_IDENT.fullmatch(table) is None:
            continue
        groups.setdefault(table, []).append(path)
    return groups


def group_parquet_tables(
    files: list[tuple[str, str]], known: list[str]
) -> dict[str, list[str]]:
    """Public view of the table grouping, for callers that need to report which
    table maps to which blob path without opening a connection."""
    return _group_parquet(files, known)


def _reader(paths: list[str]) -> str:
    if len(paths) == 1:
        return f"read_parquet('{paths[0]}')"
    lst = ", ".join(f"'{p}'" for p in paths)
    return f"read_parquet([{lst}])"


def _attach_parquet_views(
    con: duckdb.DuckDBPyConnection, groups: dict[str, list[str]]
) -> None:
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {_ATTACH_ALIAS}")
    for table, paths in groups.items():
        # OR REPLACE so a warm pooled connection can re-run setup idempotently.
        con.execute(
            f'CREATE OR REPLACE VIEW {_ATTACH_ALIAS}."{table}" AS '
            f"SELECT * FROM {_reader(paths)}"
        )


def query_parquet_folder(
    files: list[tuple[str, str]], known: list[str], sql: str,
    pool_key: str | None = None,
) -> list[dict]:
    """Run read-only SQL against a folder of Parquet files exposed as views, one
    per table (mirrors the browser mountFileFolder path). With `pool_key`, the
    connection (views created) is kept warm across calls."""
    groups = _group_parquet(files, known)
    search_path = f"{_ATTACH_ALIAS},memory"

    def _setup() -> duckdb.DuckDBPyConnection:
        con = duckdb.connect()
        con.execute(f"SET extension_directory = '{_ext_dir()}'")
        _attach_parquet_views(con, groups)
        return con

    if pool_key is None:
        con = _setup()
        try:
            return _run_statements(con, search_path, sql)
        finally:
            con.close()

    return connection_pool.run_pooled(
        pool_key, _setup, lambda con: _run_statements(con, search_path, sql)
    )


def _source_setup(
    config: dict,
    password: str | None,
    files: list[tuple[str, str]] | None,
    known: list[str] | None,
) -> tuple[Callable[[], duckdb.DuckDBPyConnection], str]:
    """Return a (setup, search_path) pair that connects to the source and makes
    its tables resolvable by bare name — the same wiring query_external/query_file/
    query_parquet_folder use, factored out so materialize_parquet can reuse it."""
    engine = config.get("engine")
    if engine in ("postgresql", "mysql"):
        spec = _engine_spec(config)
        scope = _scope(config)

        def _setup_ext() -> duckdb.DuckDBPyConnection:
            con = _connect(spec["extension"])
            _attach(con, config, password)
            return con

        return _setup_ext, f"memory,{_ATTACH_ALIAS}.{scope}"

    if not files:
        raise ValueError("no files for file/parquet source materialization")

    if len(files) > 1 or any(
        f.lower().endswith((".parquet", ".pq")) for f, _ in files
    ):
        groups = _group_parquet(files, known or [])

        def _setup_pq() -> duckdb.DuckDBPyConnection:
            con = duckdb.connect()
            con.execute(f"SET extension_directory = '{_ext_dir()}'")
            _attach_parquet_views(con, groups)
            return con

        return _setup_pq, f"{_ATTACH_ALIAS},memory"

    path = files[0][1]

    def _setup_file() -> duckdb.DuckDBPyConnection:
        con = duckdb.connect()
        con.execute(f"SET extension_directory = '{_ext_dir()}'")
        _attach_file(con, str(engine), path)
        return con

    return _setup_file, f"memory,{_ATTACH_ALIAS}"


def materialize_parquet(
    config: dict,
    password: str | None,
    files: list[tuple[str, str]] | None,
    known: list[str] | None,
    select_sql: str,
    dest_path: str,
) -> None:
    """Run `select_sql` against the source and write the full result to a Parquet
    file at `dest_path`, via a one-shot (non-pooled) connection.

    Non-pooled on purpose: this can be a long full scan, and using the source's
    pooled connection (keyed by source id) would serialise — and thus block — every
    normal page query on that source for the whole materialization. A throwaway
    connection lets refresh run alongside reads.

    Written to a temp file then atomically renamed over `dest_path`, so concurrent
    readers always see either the previous complete cache or the new one — never a
    half-written file.
    """
    setup, search_path = _source_setup(config, password, files, known)
    dest = Path(dest_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + f".tmp-{os.getpid()}-{uuid.uuid4().hex}")
    con = setup()
    try:
        con.execute(f"SET search_path='{search_path}'")
        con.execute(
            f"COPY ({select_sql}) TO '{tmp.as_posix()}' (FORMAT PARQUET)"
        )
        tmp.replace(dest)
    finally:
        con.close()
        tmp.unlink(missing_ok=True)


def query_cached_parquet(path: str, sql: str) -> list[dict]:
    """Run read-only SQL against a materialized cache Parquet exposed as the view
    `concepts` — the table name the page query references."""
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    try:
        con.execute(
            f"CREATE VIEW concepts AS SELECT * FROM read_parquet('{path}')"
        )
        return _run_statements(con, "memory", sql)
    finally:
        con.close()


def introspect_parquet_folder(
    files: list[tuple[str, str]], known: list[str]
) -> list[dict]:
    """Tables + columns for a folder of Parquet files (one table per group)."""
    groups = _group_parquet(files, known)
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    result: list[dict] = []
    try:
        for table, paths in groups.items():
            cols = con.execute(f"DESCRIBE SELECT * FROM {_reader(paths)}").fetchall()
            result.append(
                {
                    "name": table,
                    "columns": [
                        {"name": str(c[0]), "type": str(c[1]), "nullable": True}
                        for c in cols
                    ],
                }
            )
    finally:
        con.close()
    return result


def introspect_external(config: dict, password: str | None) -> list[dict]:
    """ATTACH the source read-only and return its tables + columns.

    Shape mirrors the frontend's IntrospectedTable[]:
        [{ "name": str, "columns": [{ "name", "type", "nullable" }] }]
    Reads the source's own information_schema via the engine's passthrough query
    function so column types come back as native names (integer, text, date).
    Raises on connection/permission failure — the caller turns it into a result.
    """
    spec = _engine_spec(config)
    scope = _scope(config)
    con = _connect(spec["extension"])
    try:
        _attach(con, config, password)
        # Single-quotes doubled for the nested SQL literal; `scope` is validated.
        inner = (
            "SELECT table_name, column_name, data_type, is_nullable, ordinal_position "
            "FROM information_schema.columns "
            f"WHERE table_schema = ''{scope}'' "
            "ORDER BY table_name, ordinal_position"
        )
        rows = con.execute(
            f"SELECT * FROM {spec['query_fn']}('{_ATTACH_ALIAS}', '{inner}')"
        ).fetchall()
    finally:
        con.close()

    tables: dict[str, list[dict]] = {}
    for table_name, column_name, data_type, is_nullable, _pos in rows:
        tables.setdefault(str(table_name), []).append(
            {
                "name": str(column_name),
                "type": str(data_type),
                "nullable": str(is_nullable).upper() == "YES",
            }
        )
    return [{"name": name, "columns": cols} for name, cols in tables.items()]


# --- ETL runs (writable target + read-only role databases) ------------------

class EtlRunCancelled(Exception):
    """The run was stopped because its caller went away (client reload/disconnect)."""


class EtlRunHandle:
    """A live ETL run, so a caller whose request died can stop it.

    `asyncio.to_thread` CANNOT be cancelled: when the client goes away (a browser
    reload mid-run), the request coroutine is cancelled and the `await` returns,
    but the worker thread runs on — still holding the target ATTACHed. Every retry
    then hit "Unique file handle conflict: ... already attached by database
    'target'" until that thread finished, which for a vocabulary script copying
    millions of concept rows meant minutes. It looked permanent, and restarting the
    server "fixed" it only by killing the thread.

    `interrupt()` is safe from another thread and aborts the statement in progress,
    so the run unwinds through its own `finally` and releases the file.
    """

    __slots__ = ("_con", "_lock", "_cancelled", "_done")

    def __init__(self) -> None:
        self._con: duckdb.DuckDBPyConnection | None = None
        self._lock = threading.Lock()
        self._cancelled = False
        self._done = False

    def _bind(self, con: duckdb.DuckDBPyConnection) -> bool:
        """Attach the connection to this handle. False when already cancelled —
        the caller gave up before the connection existed, so don't start."""
        with self._lock:
            if self._cancelled:
                return False
            self._con = con
            return True

    def _finish(self) -> None:
        with self._lock:
            self._con = None
            self._done = True

    def cancel(self) -> None:
        """Abort the run. Safe to call from any thread, before or after the run
        starts, and more than once."""
        with self._lock:
            self._cancelled = True
            con = self._con if not self._done else None
        if con is not None:
            try:
                con.interrupt()
            except Exception:  # noqa: BLE001 — already finishing is fine
                pass

    @property
    def cancelled(self) -> bool:
        with self._lock:
            return self._cancelled


def run_etl_sql(
    target_path: str,
    sql: str,
    roles: dict[str, dict] | None = None,
    mapping_data: dict[str, str] | None = None,
    handle: EtlRunHandle | None = None,
    on_statement: Callable[[int, int, str], None] | None = None,
) -> list[dict]:
    """Run an ETL script against a writable managed DuckDB file.

    Scripts address databases by role (`target.`, `source.`, `vocab.`). Each role
    is ATTACHed under its own name in ONE connection, so a statement may read one
    database and write another — `INSERT INTO target.person SELECT ... FROM
    source.patients` — which a per-source connection cannot express.

    Only the target is writable; the others attach READ_ONLY so a script cannot
    modify the data it is reading from.

    `roles` maps a role name to its inputs:
        {"source": {"kind": "file",    "path": "..."},
         "vocab":  {"kind": "parquet", "files": [(name, path), ...],
                    "known": [...]}}

    `mapping_data` maps a `mapping.<name>` export to its CSV text. Each is
    written to a temp file for the duration of the run and the matching
    `'mapping.<name>'` literal is rewritten to that path, so the script can
    read rows that are deliberately absent from the versioned SQL.

    `on_statement(index, total, sql)` reports progress as the script advances.
    The whole script runs on ONE connection, so session state (`SET VARIABLE`,
    temp tables) carries from one statement to the next; sending the statements
    as separate requests would give each its own connection and lose it.
    """
    # An in-memory hub, with every role ATTACHed onto it. Opening the target file
    # directly would name that database after the file and make it impossible to
    # also attach it as `target` (DuckDB refuses the same file twice).
    con = duckdb.connect()
    # Registered before the first ATTACH: a cancel arriving in that window must
    # still be able to stop the run, or it would attach and hold the file anyway.
    if handle is not None and not handle._bind(con):
        con.close()
        raise EtlRunCancelled()
    with tempfile.TemporaryDirectory(prefix="linkr-mapping-") as tmp:
        try:
            con.execute(f"SET extension_directory = '{_sql_path(_ext_dir())}'")
            con.execute(f"ATTACH '{_sql_path(target_path)}' AS target")

            # A parquet role reads its .parquet files lazily at query time, and a
            # mapping.<name> ref is a CSV read from tmp — both need local file
            # access, so external access can only be cut when neither is present.
            needs_file_access = bool(mapping_data)
            # Files already attached, by absolute path -> the database name holding
            # them. DuckDB refuses to attach one FILE twice however it is aliased,
            # so a role pointing at an already-attached file is aliased instead.
            attached: dict[str, str] = {_real_path(target_path): "target"}
            for role, spec in (roles or {}).items():
                if role.lower() == "target":
                    continue
                same_as = _already_attached_as(spec, attached)
                if same_as is not None:
                    _alias_role(con, role, same_as)
                else:
                    _attach_role(con, role, spec)
                    if spec.get("kind") == "file":
                        attached.setdefault(_real_path(spec["path"]), role)
                if spec.get("kind") in ("parquet", "external"):
                    needs_file_access = True

            sql = _resolve_mapping_refs(sql, mapping_data or {}, tmp)

            # Checked on the FINAL sql, after mapping refs are resolved, so nothing
            # can be smuggled in through a `'mapping.<name>'` substitution.
            _reject_forbidden_statements(sql)

            # The role databases (sqlite/postgres/mysql) needed their extensions
            # loaded above; now that every legitimate attach is done, forbid the
            # client SQL from installing/loading anything else and lock the config
            # so it can't reopen the door (e.g. httpfs to read /etc or exfiltrate).
            if not needs_file_access:
                # Nothing legitimate needs the filesystem/network → deny it so the
                # script can't read arbitrary paths. Must precede lock_configuration.
                con.execute("SET enable_external_access=false")
            _lock_down_user_sql(con)

            # Unqualified names must not silently fall back to another attached
            # database: keep the writable target first.
            search_path = "target,memory"
            return _run_statements(con, search_path, sql, on_statement=on_statement)
        except duckdb.InterruptException as e:
            # Only a cancel raises this — report it as such rather than as a SQL
            # error, so the caller does not surface "Interrupted!" to the user.
            if handle is not None and handle.cancelled:
                raise EtlRunCancelled() from e
            raise
        finally:
            if handle is not None:
                handle._finish()
            con.close()


# `'mapping.<name>'` inside a string literal — the only place it is meaningful.
# Mirrors MAPPING_REF in apps/web/src/lib/duckdb/mapping-source.ts.
_MAPPING_REF = re.compile(r"""(['"])mapping\.([a-z_][a-z0-9_]*)\1""", re.IGNORECASE)


def _resolve_mapping_refs(sql: str, data: dict[str, str], tmp_dir: str) -> str:
    """Write each referenced export to `tmp_dir` and point the SQL at it.

    An unknown export is left as written, so the error names the missing export
    rather than a path that means nothing."""
    written: dict[str, str] = {}

    def replace(match: re.Match[str]) -> str:
        name = match.group(2).lower()
        if name not in data:
            return match.group(0)
        path = written.get(name)
        if path is None:
            path = os.path.join(tmp_dir, f"{name}.csv")
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(data[name])
            written[name] = path
        escaped = path.replace("'", "''")
        return f"'{escaped}'"

    return _MAPPING_REF.sub(replace, sql)


def _real_path(path: str) -> str:
    """A file's identity for attach purposes.

    Resolved and case-folded: DuckDB compares open file handles, so a symlink, a
    relative path or a different casing on macOS/Windows all name the same file
    and would collide even though the strings differ."""
    return os.path.normcase(os.path.realpath(path))


def _already_attached_as(spec: dict, attached: dict[str, str]) -> str | None:
    """The database already holding this role's file, or None.

    Only `file` roles can collide: a parquet role attaches a fresh `:memory:`
    database, and an external one opens a network connection — neither is a local
    file handle."""
    if spec.get("kind") != "file":
        return None
    return attached.get(_real_path(spec["path"]))


def _alias_role(con: duckdb.DuckDBPyConnection, role: str, target_db: str) -> None:
    """Make `role.` resolve to an already-attached database.

    A pipeline may legitimately point two roles at one database — reading and
    writing the same warehouse (`source` == `target`) is the normal shape for an
    in-place transform. DuckDB rejects the second ATTACH of that file with "Unique
    file handle conflict", which surfaced as an opaque Binder Error that no restart
    could fix, since the pipeline was misread as a stale lock.

    Aliasing rather than re-attaching: a real (empty, in-memory) database named
    after the role, holding a view per table. A schema of that name in `memory`
    would not resolve, because `role.table` is looked up as a schema of the target
    first — the same reasoning as the parquet branch below.

    The views are built from the tables present at attach time. A table the script
    CREATEs later is not visible through the alias, which is the honest limit: the
    alias is a read-only window onto the other role, and the script writes through
    `target`."""
    role = _require_ident(role, "role name")
    con.execute(f'ATTACH \':memory:\' AS "{role}"')
    rows = con.execute(
        "SELECT table_schema, table_name FROM information_schema.tables "
        "WHERE table_catalog = ?",
        [target_db],
    ).fetchall()
    for schema, table in rows:
        safe_schema = _require_ident(str(schema), "schema name")
        safe_table = _require_ident(str(table), "table name")
        # Mirror non-main schemas too, so `source.other.t` keeps working.
        if safe_schema != "main":
            con.execute(f'CREATE SCHEMA IF NOT EXISTS "{role}"."{safe_schema}"')
        con.execute(
            f'CREATE OR REPLACE VIEW "{role}"."{safe_schema}"."{safe_table}" AS '
            f'SELECT * FROM "{target_db}"."{safe_schema}"."{safe_table}"'
        )


def _attach_role(con: duckdb.DuckDBPyConnection, role: str, spec: dict) -> None:
    """ATTACH one role database READ_ONLY under its role name.

    `role` comes from client `roles` keys and table names from uploaded Parquet
    filenames, so both are validated as identifiers before being quoted in, and
    every path goes through a single-quote escape."""
    role = _require_ident(role, "role name")
    kind = spec.get("kind")
    if kind == "parquet":
        # A Parquet folder is not a database: expose its tables as views in a
        # schema named after the role, which resolves `role.table` the same way.
        # Attach a real (empty, in-memory) database named after the role and put
        # the views in ITS main schema. A schema of the same name in `memory`
        # would not resolve: `role.table` is looked up as schema-of-target first.
        groups = _group_parquet(spec.get("files") or [], spec.get("known") or [])
        con.execute(f'ATTACH \':memory:\' AS "{role}"')
        for table, paths in groups.items():
            safe_table = _require_ident(table, "parquet table name")
            con.execute(
                f'CREATE OR REPLACE VIEW "{role}".main."{safe_table}" '
                f"AS SELECT * FROM {_reader(paths)}"
            )
        return
    if kind == "file":
        path = _sql_path(spec["path"])
        if spec.get("engine") == "sqlite":
            con.execute("INSTALL sqlite")
            con.execute("LOAD sqlite")
            con.execute(f"ATTACH '{path}' AS \"{role}\" (TYPE sqlite, READ_ONLY)")
        else:
            con.execute(f"ATTACH '{path}' AS \"{role}\" (READ_ONLY)")
        return
    if kind == "external":
        spec_engine = _engine_spec(spec["config"])
        con.execute(f"INSTALL {spec_engine['extension']}")
        con.execute(f"LOAD {spec_engine['extension']}")
        dsn_literal = _dsn(spec["config"], spec.get("password"))
        con.execute(
            f"ATTACH '{dsn_literal}' AS \"{role}\" "
            f"(TYPE {spec_engine['type']}, READ_ONLY)"
        )
        return
    raise ValueError(f"cannot attach role {role!r}: unknown kind {kind!r}")
