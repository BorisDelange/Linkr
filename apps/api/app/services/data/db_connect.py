"""Server-side connection to external SQL databases (PostgreSQL, MySQL).

Uses DuckDB's ``postgres`` / ``mysql`` extensions to ATTACH a live database
read-only, introspect its schema and run SQL — the same DuckDB SQL dialect the
whole app already speaks, so no per-engine query rewriting and no extra hard
dependency (DuckDB is already required). The password is passed in per call and
never stored: it lives only for the duration of the connection.
"""

import contextvars
import datetime
import logging
import os
import re
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path

import duckdb

from app.config import settings
from app.services.data import connection_pool, file_reader, flight, query_cancel, remote_sql
from app.services.data.db_host_guard import check_db_host

logger = logging.getLogger(__name__)

_ATTACH_ALIAS = "ext"

# Safety cap on rows returned to the browser. The UI paginates/displays far less;
# an uncapped SELECT * on a huge table would otherwise overwhelm the response.
MAX_QUERY_ROWS = 10_000

# Ceiling on a request that asks for more than MAX_QUERY_ROWS (a data catalog's
# crossing can hold hundreds of thousands of cells). Paging would re-run the
# whole aggregate once per page, which over a large warehouse costs far more
# than the payload.
MAX_QUERY_ROWS_ALL = 2_000_000

# The row cap of the query the current request runs; the route raises it for a
# caller that needs the whole result. Read in the worker thread, which inherits
# the request's context through `asyncio.to_thread`.
row_cap: contextvars.ContextVar[int] = contextvars.ContextVar("row_cap", default=MAX_QUERY_ROWS)

# Per-engine wiring: the DuckDB extension, the ATTACH TYPE, the passthrough
# query function used to read the source's own information_schema, and whether
# the ATTACH can be READ_ONLY. Doris speaks the MySQL protocol but rejects the
# `START TRANSACTION READ ONLY` a READ_ONLY attach sends, so it attaches writable
# and the login itself must be read-only (_require_read_only_doris_login).
_ENGINES = {
    "postgresql": {"extension": "postgres", "type": "postgres", "query_fn": "postgres_query", "read_only": True},
    "mysql": {"extension": "mysql", "type": "mysql", "query_fn": "mysql_query", "read_only": True},
    "doris": {"extension": "mysql", "type": "mysql", "query_fn": "mysql_query", "read_only": False},
}
EXTERNAL_ENGINES = tuple(_ENGINES)
_MYSQL_PROTOCOL = ("mysql", "doris")


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
# What ends a `--` comment for DuckDB. A bare \r counts: see _line_comment_end.
_LINE_END_RE = re.compile(r"\r\n|[\r\n]")


def _require_ident(value: str, what: str) -> str:
    if not isinstance(value, str) or _SAFE_IDENT.fullmatch(value) is None:
        raise ValueError(f"invalid {what}: {value!r}")
    return value


def _sql_path(path: str) -> str:
    """A filesystem path escaped for a single-quoted SQL literal."""
    return str(path).replace("'", "''")


_GLOB_CHARS = re.compile(r"[*?\[]")


def skip_glob_path(path: str) -> bool:
    """Whether `read_parquet` would expand `path` as a glob (`a?.parquet` also reads
    `ab.parquet`), logging a warning when it would. Such a file is left out rather
    than escaped: an escaped pattern (`a[?].parquet`) is no longer the path
    `allowed_paths` grants, so the locked-down connection could not read it anyway."""
    if _GLOB_CHARS.search(str(path)) is None:
        return False
    logger.warning("Left out a data file whose path holds a glob character (*, ? or [): %s", path)
    return True


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


def _forbid_file_access(con: duckdb.DuckDBPyConnection, readable: list[str] | None = None) -> None:
    """Cut a read-query connection off the server's filesystem, once its source is
    attached or its views created.

    Without this, the "read-only" query route ran `COPY (…) TO '/any/path'` and
    `read_csv('/etc/passwd')` as the server's user — and an agent driving the MCP
    can be talked into sending exactly that. `readable` lists the files the source's
    own views read (a Parquet folder); an already-attached database stays readable.
    Irreversible for the connection: DuckDB refuses to turn external access back on,
    and allowed_paths is frozen with it."""
    if readable:
        paths = ", ".join("'" + p.replace("'", "''") + "'" for p in readable)
        con.execute(f"SET allowed_paths=[{paths}]")
    con.execute("SET enable_external_access=false")


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
    Every client-controlled value is quoted (see _dsn_value). Every external
    connection is built here, so this is where the host allowlist applies."""
    check_db_host(config.get("host"))
    is_mysql = config.get("engine") in _MYSQL_PROTOCOL
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
    if not is_mysql:
        if sslmode := config.get("sslmode"):
            parts.append(f"sslmode={_dsn_value(sslmode)}")
        if app_name := config.get("application_name"):
            parts.append(f"application_name={_dsn_value(app_name)}")
    return " ".join(parts)


def _scope(config: dict) -> str:
    """The schema (Postgres) or database (MySQL) whose tables we expose. Validated
    as a plain identifier since it is interpolated into SQL below."""
    is_mysql = config.get("engine") in _MYSQL_PROTOCOL
    scope = config.get("schema") or config.get("database") if is_mysql else config.get("schema")
    scope = scope or ("mysql" if is_mysql else "public")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", scope):
        raise ValueError(f"invalid schema/database name: {scope!r}")
    return scope


def attach_recipe(config: dict, password: str | None) -> dict:
    """The ATTACH ingredients for an external database, for a client that opens the
    connection itself (the R/Python libraries) rather than asking the server to run
    the query. Same DSN and scope `_attach` uses here, so a client-side connection
    behaves exactly like the app's own."""
    spec = _engine_spec(config)
    return {
        "type": spec["type"],
        "dsn": _dsn(config, password),
        "scope": _scope(config),
        "readOnly": spec["read_only"],
    }


# Doris privileges that only read. Anything else on a data object (Load, Alter,
# Create, Drop) or globally (Admin, Node, Grant) lets the login write.
_DORIS_READ_PRIVS = {"select_priv", "show_view_priv"}
# SHOW GRANTS columns that grant rights on data. The others (workload groups,
# compute groups, resources, storage vaults) only grant usage of capacity.
_DORIS_DATA_PRIV_COLUMNS = ("GlobalPrivs", "CatalogPrivs", "DatabasePrivs", "TablePrivs", "ColPrivs")
_DORIS_PRIV_NAME = re.compile(r"[A-Za-z_]+_priv", re.IGNORECASE)


def _doris_write_privileges(grants: list[dict]) -> list[str]:
    """The write-capable privileges in a Doris `SHOW GRANTS` result. Role grants
    are already merged into these columns by Doris."""
    found: set[str] = set()
    for row in grants:
        for column in _DORIS_DATA_PRIV_COLUMNS:
            for name in _DORIS_PRIV_NAME.findall(str(row.get(column) or "")):
                if name.lower() not in _DORIS_READ_PRIVS:
                    found.add(name)
    return sorted(found)


def _require_read_only_doris_login(con: duckdb.DuckDBPyConnection, alias: str) -> None:
    """Refuse a Doris login that can write. Doris cannot be attached READ_ONLY, so
    this is what keeps a query from writing to the warehouse."""
    cur = con.execute(f"SELECT * FROM mysql_query('{alias}', 'SHOW GRANTS')")
    names = [d[0] for d in cur.description]
    grants = [dict(zip(names, row)) for row in cur.fetchall()]
    writes = _doris_write_privileges(grants)
    if writes:
        raise ValueError(
            "Linkr only connects to Doris with a read-only login (SELECT only); "
            f"this one also holds {', '.join(writes)}"
        )


def _attach_external(
    con: duckdb.DuckDBPyConnection, alias: str, config: dict, password: str | None,
) -> None:
    """ATTACH an external database under `alias` (already a safe identifier),
    read-only — by the ATTACH where the engine allows it, else by its login."""
    spec = _engine_spec(config)
    # The DSN goes into a single-quoted SQL literal; double any single quote a
    # value may still legitimately contain (e.g. a password) so it can't close it.
    dsn_literal = _dsn(config, password).replace("'", "''")
    options = f"TYPE {spec['type']}" + (", READ_ONLY" if spec["read_only"] else "")
    con.execute(f"ATTACH '{dsn_literal}' AS \"{alias}\" ({options})")
    if config.get("engine") == "doris":
        _require_read_only_doris_login(con, alias)


def _attach(con: duckdb.DuckDBPyConnection, config: dict, password: str | None) -> None:
    _attach_external(con, _ATTACH_ALIAS, config, password)


# --- Compute pushdown (remote_sql) -------------------------------------------

# A scope's columns change only with the remote schema: re-read after this long.
_REMOTE_COLUMNS_TTL = 300.0
_remote_columns_cache: dict[tuple, tuple[float, dict[str, dict[str, str]]]] = {}
_remote_columns_lock = threading.Lock()

# Remote type names (information_schema.data_type) as the SQL types remote_sql
# reasons on. Doris suffixes its newer storage formats (datetimev2, decimalv3).
_REMOTE_TYPE_ALIASES = {"string": "TEXT", "largeint": "HUGEINT", "datetime": "TIMESTAMP"}
_REMOTE_TYPE_SUFFIX = re.compile(r"v\d+$")


def _remote_type(data_type: str) -> str:
    name = _REMOTE_TYPE_SUFFIX.sub("", str(data_type).strip().lower())
    return _REMOTE_TYPE_ALIASES.get(name, name.upper())


def _scope_columns(con: duckdb.DuckDBPyConnection, config: dict) -> dict[str, dict[str, str]]:
    """Table → {column: type} of the source's scope, lower-cased, from its own
    information_schema."""
    spec = _engine_spec(config)
    scope = _scope(config)
    key = (config.get("engine"), config.get("host"), config.get("port"), config.get("database"), scope)
    with _remote_columns_lock:
        hit = _remote_columns_cache.get(key)
    if hit and time.monotonic() - hit[0] < _REMOTE_COLUMNS_TTL:
        return hit[1]
    inner = (
        "SELECT table_name, column_name, data_type FROM information_schema.columns "
        f"WHERE table_schema = ''{scope}''"
    )
    columns: dict[str, dict[str, str]] = {}
    for table, column, data_type in con.execute(
        f"SELECT * FROM {spec['query_fn']}('{_ATTACH_ALIAS}', '{inner}')"
    ).fetchall():
        columns.setdefault(str(table).lower(), {})[str(column).lower()] = _remote_type(data_type)
    with _remote_columns_lock:
        _remote_columns_cache[key] = (time.monotonic(), columns)
    return columns


# How the mysql extension reports a statement the server rejected before running
# it (its prepare step), as opposed to one that failed while running.
_REMOTE_PREPARE_FAILED = "Failed to prepare MySQL query"


def _pushed_down(con: duckdb.DuckDBPyConnection, config: dict, sql: str) -> remote_sql.RemoteQuery | None:
    """`sql` in the external database's own SQL, or None when it is not portable
    (remote_sql) — the caller then runs it as is."""
    engine = config.get("engine")
    if engine not in remote_sql.PUSHDOWN_ENGINES:
        return None
    try:
        return remote_sql.to_remote(
            sql, engine, _scope(config),
            lambda table: _scope_columns(con, config).get(table.lower()),
        )
    except remote_sql.NotPortable as exc:
        logger.debug("query not pushed down (%s)", exc)
        return None


def _renamed(source: str, remote: remote_sql.RemoteQuery) -> str:
    names = ", ".join('"' + n.replace('"', '""') + '"' for n in remote.columns)
    return f"SELECT * FROM {source} AS _remote({names})"


def _passthrough(config: dict, remote: remote_sql.RemoteQuery) -> str:
    literal = remote.sql.replace("'", "''")
    return _renamed(f"{_engine_spec(config)['query_fn']}('{_ATTACH_ALIAS}', '{literal}')", remote)


def _flight_probe(con: duckdb.DuckDBPyConnection, config: dict) -> str | None:
    """One row of a table of the scope, in the engine's SQL (see flight.problem)."""
    tables = sorted(_scope_columns(con, config))
    if not tables:
        return None
    quote = lambda name: "`" + name.replace("`", "``") + "`"  # noqa: E731
    return f"SELECT 1 AS one FROM {quote(_scope(config))}.{quote(tables[0])} LIMIT 1"


def flight_problem(config: dict, password: str | None) -> tuple[str, str | None] | None:
    """Why Flight cannot carry this source's large results, or None (see flight)."""
    if flight.port(config) is None:
        return None
    con = _connect(_engine_spec(config)["extension"])
    try:
        _attach(con, config, password)
        return flight.problem(config, password, _flight_probe(con, config))
    finally:
        con.close()


def _run_over_flight(
    con: duckdb.DuckDBPyConnection, config: dict, password: str | None,
    remote: remote_sql.RemoteQuery, run: Callable[[str], object],
):
    """`run` over the result streamed by Flight, registered as a view of `con`.
    Raises flight.Unreachable when the transport fails before any row is read."""
    view = f"_flight_{uuid.uuid4().hex}"
    cancelled: list[bool] = []
    with flight.reader(config, password, remote.sql) as (batches, cancel):
        con.register(view, batches)
        try:
            with query_cancel.on_cancel(lambda: (cancelled.append(True), cancel())):
                return run(_renamed(f'"{view}"', remote))
        except duckdb.Error as exc:
            if cancelled:
                raise duckdb.InterruptException("query cancelled") from exc
            if flight.is_transport_error(exc):
                raise flight.Unreachable(str(exc).splitlines()[0]) from exc
            raise
        finally:
            con.unregister(view)


class _RemoteKill:
    """Stops a pushed-down statement on the database's side, from a connection of
    its own: the one running it is busy, and DuckDB's interrupt only takes effect
    once the remote statement returns."""

    def __init__(self, config: dict, password: str | None, connection_id: int):
        self.config, self.password, self.connection_id = config, password, connection_id
        self.fired = False
        self.done = False

    def __call__(self) -> None:
        self.fired = True
        threading.Thread(target=self._kill, daemon=True).start()

    def _kill(self) -> None:
        if self.done:
            return
        try:
            con = _connect(_engine_spec(self.config)["extension"])
            try:
                _attach(con, self.config, self.password)
                con.execute(f"CALL mysql_execute('{_ATTACH_ALIAS}', 'KILL QUERY {self.connection_id}')")
            finally:
                con.close()
        except Exception as exc:  # noqa: BLE001 — the statement then runs to its end, as before
            logger.warning("could not stop a pushed-down query on the database: %s", exc)


def _with_pushdown(
    con: duckdb.DuckDBPyConnection, config: dict, password: str | None, sql: str,
    run: Callable[[str], object], bulk: bool = False,
):
    """`run` the pushed-down form of `sql` when there is one, else `sql`. A `bulk`
    result goes over Arrow Flight when the database offers it (flight).

    A query the database refuses to prepare (a function or type it does not
    know) falls back to the ATTACH: slower, same answer. One that failed while
    running (out of memory, timed out, cancelled) is not retried that way: the
    ATTACH would pull every row the database could not even aggregate."""
    remote = _pushed_down(con, config, sql)
    if remote is None:
        return run(sql)
    if bulk and flight.port(config) is not None and flight.problem(config, password, _flight_probe(con, config)) is None:
        try:
            return _run_over_flight(con, config, password, remote, run)
        except flight.Unreachable as exc:
            flight.record(config, (flight.UNREACHABLE, str(exc)[:300]))
    query_fn = _engine_spec(config)["query_fn"]
    connection_id = con.execute(
        f"SELECT * FROM {query_fn}('{_ATTACH_ALIAS}', 'SELECT CONNECTION_ID() AS id')"
    ).fetchone()[0]
    kill = _RemoteKill(config, password, int(connection_id))
    try:
        with query_cancel.on_cancel(kill):
            return run(_passthrough(config, remote))
    except duckdb.IOException as exc:
        if kill.fired:
            raise duckdb.InterruptException("query cancelled") from exc
        if _REMOTE_PREPARE_FAILED not in str(exc):
            raise
        logger.warning("pushed-down query refused by the database, ran it locally: %s", exc)
        return run(sql)
    finally:
        kill.done = True


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


def _line_comment_end(sql: str, i: int) -> int:
    """Index just past the `--` comment starting at `i`.

    DuckDB ends a line comment at a bare carriage return, not only at `\\n`, so
    scanning for `\\n` alone let `--\\rINSTALL httpfs;` be swallowed whole as a
    "comment" — hiding the keyword from `_reject_forbidden_statements` while
    DuckDB happily executed it. Same bypass class as the leading `/* */` one,
    a different terminator.
    """
    m = _LINE_END_RE.search(sql, i)
    return len(sql) if m is None else m.end()


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
            i = _line_comment_end(stmt, i)
        elif stmt.startswith("/*", i):
            end = stmt.find("*/", i + 2)
            i = n if end == -1 else end + 2
        else:
            break
    return stmt[i:]


def _is_escape_string_prefix(sql: str, quote: int) -> bool:
    """Whether the quote at `quote` opens an E'...' literal — an E right before
    it that does not end a longer word. Mirrors sql-tokenizer.ts."""
    before = sql[quote - 1] if quote >= 1 else ""
    earlier = sql[quote - 2] if quote >= 2 else ""
    return before in ("e", "E") and not (earlier.isalnum() or earlier in "_$")


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
            stop = _line_comment_end(sql, i)
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
            # A backslash escapes the next char inside an E'...\'...' literal
            # only: in a plain one DuckDB reads '\' as a whole string, and taking
            # its quote as escaped hid the statements after it from the guards.
            backslash_escapes = ch == "'" and _is_escape_string_prefix(sql, i)
            j = i + 1
            while j < n:
                if backslash_escapes and sql[j] == "\\" and j + 1 < n:
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
# filesystem/network gate: it can be switched off on a running connection, with
# `allowed_paths` naming the files that stay reachable (`_forbid_file_access`, which
# every read route and the ETL runner apply). The extension surface is closed here
# as well, so an explicit `INSTALL httpfs; LOAD httpfs` is refused before it reaches
# DuckDB rather than relying on that one setting alone.
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
        m = _leading_match(_FORBIDDEN_IN_USER_SQL, stmt)
        if m:
            raise ValueError(f"{m.group(1).upper()} is not allowed in a pipeline script")


# Where a token's own text stops: DuckDB's tokenizer only gives start offsets, so
# the slice up to the next token also carries the whitespace and any comment glued
# to it (`TO/**/'x'` slices as `TO/**/`).
_TOKEN_END = re.compile(r"\s|/\*|--")


def _token_texts(stmt: str) -> list[tuple[str, "duckdb.token_type"]]:
    """(text, kind) per token, upper-cased, without the trailing whitespace or comment."""
    tokens = duckdb.tokenize(stmt)
    ends = [pos for pos, _ in tokens[1:]] + [len(stmt)]
    out = []
    for i, (pos, kind) in enumerate(tokens):
        raw = stmt[pos:ends[i]]
        m = _TOKEN_END.search(raw)
        out.append(((raw[:m.start()] if m else raw).upper(), kind))
    return out


def _leading_match(pattern: re.Pattern[str], stmt: str) -> re.Match[str] | None:
    """`pattern` matched on the statement's opening, as written and as its first two
    tokens: a comment between them (`FORCE/**/INSTALL httpfs`) hides the pair from
    a regex but not from DuckDB."""
    text = _strip_leading_noise(stmt)
    return pattern.match(text) or pattern.match(" ".join(t for t, _ in _token_texts(text)[:2]))


def _copies_to_a_file(stmt: str) -> bool:
    """Whether `stmt` is a `COPY … TO` (writes out) rather than a `COPY … FROM`
    (loads in): the first FROM/TO keyword outside parentheses after COPY decides,
    so `COPY (SELECT … FROM t) TO` reads as TO."""
    depth = 0
    for i, (text, kind) in enumerate(_token_texts(stmt)):
        if i == 0:
            if kind != duckdb.token_type.keyword or text != "COPY":
                return False
        elif kind == duckdb.token_type.operator:
            depth += text.count("(") - text.count(")")
        elif depth == 0 and kind == duckdb.token_type.keyword and text in ("FROM", "TO"):
            return text == "TO"
    return False


def _explained(stmt: str) -> tuple[str, bool] | None:
    """The statement an EXPLAIN wraps and whether EXPLAIN runs it (`ANALYZE`, bare
    or among the parenthesised options), or None when its target cannot be read."""
    tokens = duckdb.tokenize(stmt)
    texts = [text.strip('"') for text, _ in _token_texts(stmt)]
    if not texts or texts[0] != "EXPLAIN":
        return None
    i, analyze = 1, False
    if i < len(texts) and texts[i] == "ANALYZE":
        i, analyze = i + 1, True
    if i >= len(tokens):
        return None
    try:
        duckdb.extract_statements(stmt[tokens[i][0]:])
        return stmt[tokens[i][0]:], analyze
    except duckdb.Error:
        pass
    if texts[i] != "(":
        return None
    depth = 0
    for j in range(i, len(texts)):
        depth += texts[j].count("(") - texts[j].count(")")
        if texts[j] == "ANALYZE":
            analyze = True
        if depth == 0:
            return (stmt[tokens[j + 1][0]:], analyze) if j + 1 < len(tokens) else None
    return None


def _classified(stmt: str) -> list[tuple[duckdb.StatementType, str, bool | None]]:
    """What DuckDB's parser makes of `stmt`: (type, text, explain) per statement,
    an EXPLAIN reported as the statement it wraps with `explain` saying whether it
    runs it (None when there is no EXPLAIN). A statement the parser refuses yields
    nothing: running it fails the same way. An EXPLAIN whose target cannot be read
    comes back as INVALID."""
    try:
        parsed = duckdb.extract_statements(stmt)
    except duckdb.Error:
        return []
    out: list[tuple[duckdb.StatementType, str, bool | None]] = []
    for s in parsed:
        if s.type != duckdb.StatementType.EXPLAIN:
            out.append((s.type, s.query, None))
            continue
        target = _explained(_strip_leading_noise(s.query))
        if target is None:
            out.append((duckdb.StatementType.INVALID, s.query, True))
            continue
        inner, analyze = target
        out.extend((t, text, analyze) for t, text, _ in _classified(inner) or [(duckdb.StatementType.INVALID, inner, None)])
    return out


def _reject_copy_to_file(sql: str) -> None:
    """An ETL script loads files (`COPY t FROM 'mapping.x'`) but never writes one:
    the only files it can reach are its roles' Parquet inputs and its mapping CSVs,
    and `allowed_paths` would let a `COPY … TO` overwrite those shared blobs.

    The parser is asked as well, since a COPY also runs inside `EXPLAIN ANALYZE`
    and through `PREPARE … AS COPY` + `EXECUTE`, neither of which starts with COPY.
    Only a SELECT may be explained, so whether an option list really says ANALYZE
    never has to be decided; EXPORT DATABASE and COPY FROM DATABASE write files too."""
    for stmt in _split_statements(sql):
        if _copies_to_a_file(_strip_leading_noise(stmt)):
            raise ValueError("COPY … TO a file is not allowed in a pipeline script")
        for kind, text, explain in _classified(stmt):
            if kind in _FORBIDDEN_TYPES_IN_ETL:
                raise ValueError(f"{kind.name} is not allowed in a pipeline script")
            if explain is not None and kind != duckdb.StatementType.SELECT:
                raise ValueError("EXPLAIN is only allowed on a SELECT in a pipeline script")
            if kind == duckdb.StatementType.COPY and _copies_to_a_file(_strip_leading_noise(text)):
                raise ValueError("COPY … TO a file is not allowed in a pipeline script")


_FORBIDDEN_TYPES_IN_ETL = frozenset({
    duckdb.StatementType.PREPARE, duckdb.StatementType.EXECUTE,
    duckdb.StatementType.EXPORT, duckdb.StatementType.COPY_DATABASE,
})


# On a pooled connection shared by every user of a file/Parquet source, these would
# outlive the request: DETACH/USE change the catalog for everyone, and ending the
# transaction `_run_isolated` wraps the query in would let DDL persist.
#
# COPY/EXPORT because DuckDB's `allowed_paths` grants write as well as read: a
# `COPY … TO '<the source's own parquet>' (USE_TMP_FILE FALSE)` overwrites it in
# place, and those files are shared (content-addressed blobs, the concept cache).
_FORBIDDEN_IN_SHARED_READ = re.compile(
    r"^\s*(?:FORCE\s+)?"
    r"(INSTALL|LOAD|ATTACH|DETACH|USE|BEGIN|START|COMMIT|END|ROLLBACK|ABORT|COPY|EXPORT)\b",
    re.IGNORECASE,
)

# The same, as the parser sees it — which also catches them behind `PREPARE … AS`
# + `EXECUTE` (refused outright) and inside an EXPLAIN (only a SELECT may be explained).
_FORBIDDEN_TYPES_IN_SHARED_READ = frozenset({
    duckdb.StatementType.LOAD, duckdb.StatementType.ATTACH, duckdb.StatementType.DETACH,
    duckdb.StatementType.TRANSACTION, duckdb.StatementType.COPY, duckdb.StatementType.COPY_DATABASE,
    duckdb.StatementType.EXPORT, duckdb.StatementType.PREPARE, duckdb.StatementType.EXECUTE,
})


def _reject_session_statements(sql: str) -> None:
    for stmt in _split_statements(sql):
        m = _leading_match(_FORBIDDEN_IN_SHARED_READ, stmt)
        if m:
            raise ValueError(f"{m.group(1).upper()} is not allowed in a query")
        for kind, _, explain in _classified(stmt):
            if explain is not None and kind != duckdb.StatementType.SELECT:
                raise ValueError("EXPLAIN is only allowed on a SELECT in a query")
            if kind in _FORBIDDEN_TYPES_IN_SHARED_READ:
                raise ValueError(f"{kind.name} is not allowed in a query")


def _run_isolated(con: duckdb.DuckDBPyConnection, search_path: str, sql: str, arrow: bool):
    """`_run_read` inside a transaction that is always rolled back, so a view, table
    or macro the query creates never reaches the next caller of the connection.
    Session variables are not transactional, hence the explicit reset."""
    _reject_session_statements(sql)
    con.execute("BEGIN TRANSACTION")
    try:
        return _run_read(con, search_path, sql, arrow)
    finally:
        con.execute("ROLLBACK")
        for (name,) in con.execute("SELECT name FROM duckdb_variables()").fetchall():
            quoted = '"' + name.replace('"', '""') + '"'
            con.execute(f"RESET VARIABLE {quoted}")


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


def _run_read(con: duckdb.DuckDBPyConnection, search_path: str, sql: str, arrow: bool):
    with query_cancel.tracking(con):
        return _run_to_arrow(con, search_path, sql) if arrow else _run_statements(con, search_path, sql, row_cap.get())


def _run_to_arrow(con: duckdb.DuckDBPyConnection, search_path: str, sql: str):
    """`_run_statements` without the row cap, returning the last result as an Arrow
    table — for server-side consumers that write the whole result somewhere (a
    dataset from a query) and must not truncate it."""
    con.execute(f"SET search_path='{search_path}'")
    result: duckdb.DuckDBPyConnection | None = None
    for stmt in _split_statements(sql):
        result = con.execute(stmt)
    if result is None or result.description is None:
        raise ValueError("the query returns no rows")
    return result.fetch_arrow_table()


def query_external(
    config: dict, password: str | None, sql: str, pool_key: str | None = None,
    arrow: bool = False, pushdown: bool = False,
):
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

    `pushdown`: let the external database compute the query when it is portable
    (remote_sql) — for the app's own aggregates, never for a user's SQL.
    """
    spec = _engine_spec(config)
    scope = _scope(config)
    search_path = f"memory,{_ATTACH_ALIAS}.{scope}"

    def _setup() -> duckdb.DuckDBPyConnection:
        con = _connect(spec["extension"])
        _attach(con, config, password)
        _forbid_file_access(con)
        return con

    def _read(con: duckdb.DuckDBPyConnection):
        if not pushdown:
            return _run_read(con, search_path, sql, arrow)
        bulk = arrow or row_cap.get() > MAX_QUERY_ROWS
        return _with_pushdown(con, config, password, sql, lambda q: _run_read(con, search_path, q, arrow), bulk)

    if pool_key is None:
        con = _setup()
        try:
            return _read(con)
        finally:
            con.close()

    return connection_pool.run_pooled(pool_key, _setup, _read)


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
    engine: str, path: str, sql: str, pool_key: str | None = None, arrow: bool = False,
):
    """Run SQL against a local DuckDB/SQLite file (server-side). Read-only file;
    CREATE VIEW / temp tables land in the writable `memory` catalog and are rolled
    back after the call. With `pool_key`, the ATTACHed connection is kept warm
    across calls — shared by every user of the source, hence `_run_isolated`."""

    def _setup() -> duckdb.DuckDBPyConnection:
        con = duckdb.connect()
        con.execute(f"SET extension_directory = '{_ext_dir()}'")
        _attach_file(con, engine, path)
        _forbid_file_access(con)
        _lock_down_user_sql(con)
        return con

    if pool_key is None:
        con = _setup()
        try:
            return _run_isolated(con, _file_search_path(con), sql, arrow)
        finally:
            con.close()

    return connection_pool.run_pooled(
        pool_key, _setup, lambda con: _run_isolated(con, _file_search_path(con), sql, arrow)
    )


def _file_search_path(con: duckdb.DuckDBPyConnection) -> str:
    """`memory`, the attached file, then each of the file's own schemas.

    Without the schemas, a file holding tables outside `main` — a database
    derived from a multi-schema source keeps MIMIC-IV's `hosp`/`icu` — answered
    `hosp.patients` with "schema does not exist": a two-part name is looked up
    through the search path, which named the file's catalog but none of its
    schemas. Read each run, since a derivation may add a schema to a warm file."""
    rows = con.execute(
        "SELECT schema_name FROM information_schema.schemata WHERE catalog_name = ? "
        "AND schema_name NOT IN ('main', 'information_schema', 'pg_catalog') ORDER BY schema_name",
        [_ATTACH_ALIAS],
    ).fetchall()
    # A name that is not a plain identifier is left off rather than raised on: it
    # stays reachable fully qualified, and must not break every query on the file.
    schemas = [f'{_ATTACH_ALIAS}."{r[0]}"' for r in rows if _SAFE_IDENT.fullmatch(str(r[0]))]
    return ",".join(["memory", _ATTACH_ALIAS, *schemas])


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
        # `sql` is arbitrary client SQL (editor-authored, mirroring the in-browser
        # DuckDB-WASM path): only the blob — or its UTF-8 transcode — stays readable.
        _reject_session_statements(sql)
        _forbid_file_access(con, [path, *file_reader.transcoded_paths(con)])
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


# Numbered shards, bare numbers/dates, the vocabulary library's per-vocabulary
# partitions (`concept/vocab-SNOMED.parquet`) and single file of its shared
# tables (`domain/shared.parquet`), and pyarrow's `<uuid hex>-0` files.
# ASCII like the frontend's `isShardFileName`, whose `\w`/`\d` are ASCII.
_SHARD_RE = re.compile(
    r"(part|chunk|data|file)[-_.]\d+([-_.]\w+)*|\d+([-_.]\d+)*|vocab-[\w-]+|shared|[0-9a-f]{32}(-\d+)?",
    re.ASCII,
)
# A shard named after its table directory (`document/document_1999-01`): only a
# numeric/date suffix counts, so `ehop/ehop_patient` stays a table of its own.
_NAMED_SHARD_SUFFIX_RE = re.compile(r"[-_.]\d+([-_.]\d+)*", re.ASCII)
# A hive partition directory (`measurement/year=2020/…`): neither a table nor a schema.
_HIVE_SEGMENT_RE = re.compile(r"[^=]+=[^=]*")


def _path_parts(file_name: str) -> list[str]:
    """Path segments of a Parquet file, hive partition directories left out."""
    parts = [p for p in file_name.replace("\\", "/").split("/") if p]
    return [p for p in parts[:-1] if not _HIVE_SEGMENT_RE.fullmatch(p)] + parts[-1:]


def _table_of(file_name: str, known: list[str]) -> str:
    """Table name for a Parquet file, mirroring the frontend's extractTableName:
    prefer a known-table segment, else the file stem — falling back to the parent
    dir only for numbered shards (`admissions/part-00000.parquet`), where the
    directory carries the table identity."""
    parts = _path_parts(file_name)
    known_set = {k.rsplit(".", 1)[-1].lower() for k in known}
    stem = re.sub(r"\.[^.]+$", "", parts[-1]).lower()
    if stem in known_set:
        return stem
    # A known directory claims only the files that carry no name of their own, so
    # an undeclared `document/document_type.parquet` stays a table.
    for seg in reversed(parts[:-1]):
        dir_name = re.sub(r"\.[^.]+$", "", seg).lower()
        if dir_name in known_set and _is_shard_of(stem, dir_name):
            return dir_name
    if len(parts) >= 2 and _is_shard_of(stem, parts[-2].lower()):
        return parts[-2].lower()
    return stem


def _is_shard_of(stem: str, dir_name: str) -> bool:
    return bool(_SHARD_RE.fullmatch(stem)) or (
        stem.startswith(dir_name) and bool(_NAMED_SHARD_SUFFIX_RE.fullmatch(stem[len(dir_name):]))
    )


def _common_dir(names: list[str]) -> list[str]:
    """Deepest directory shared by every path — the folder that was selected.

    Mirrors the frontend's `commonDirPrefix`. It is what tells a schema directory
    apart from the download folder itself."""
    dirs = [[p for p in n.replace("\\", "/").split("/") if p][:-1] for n in names]
    if not dirs:
        return []
    shared: list[str] = []
    for i in range(min(len(d) for d in dirs)):
        seg = dirs[0][i]
        if all(d[i].lower() == seg.lower() for d in dirs):
            shared.append(seg)
        else:
            break
    return shared


def _table_ref_of(file_name: str, root: list[str], known: list[str]) -> tuple[str | None, str]:
    """`(schema, table)` for a Parquet file, mirroring the frontend's
    `extractTableRef`.

    A directory *below* the selected root names a schema — MIMIC-IV's `hosp`/`icu`,
    eHOP's Oracle schemas. The root itself never does: it is the download folder,
    and treating it as a schema would put every flat import inside one."""
    table = _table_of(file_name, known)
    parts = _path_parts(file_name)
    root = [r for r in root if not _HIVE_SEGMENT_RE.fullmatch(r)]
    below = (
        parts[len(root):]
        if len(parts) > len(root)
        and all(parts[i].lower() == r.lower() for i, r in enumerate(root))
        else parts
    )
    dirs = below[:-1]
    # Drop the directory that already named the table (the shard layout); one
    # remaining segment is the schema.
    if dirs and dirs[-1].lower() == table:
        dirs = dirs[:-1]
    return (dirs[-1].lower() if dirs else _known_schema_of(table, known)), table


def _known_schema_of(table: str, known: list[str]) -> str | None:
    """The schema the known tables give `table` when exactly one declares it, so a
    schema-qualified preset still resolves over a folder imported without its
    schema directories. Mirrors the frontend's `knownSchemaOf`."""
    schemas = {
        k.rsplit(".", 1)[0].lower()
        for k in known
        if "." in k and k.rsplit(".", 1)[1].lower() == table
    }
    return schemas.pop() if len(schemas) == 1 else None


def _group_parquet(
    files: list[tuple[str, str]], known: list[str]
) -> dict[tuple[str | None, str], list[str]]:
    """Parquet files grouped by the `(schema, table)` they belong to.

    `schema` is None for a flat folder, which is the overwhelmingly common shape
    and the one every source imported before schemas were understood."""
    root = _common_dir([n for n, _ in files if n.lower().endswith((".parquet", ".pq"))])
    groups: dict[tuple[str | None, str], list[str]] = {}
    for file_name, path in files:
        if not file_name.lower().endswith((".parquet", ".pq")):
            continue
        if skip_glob_path(path):
            continue
        schema, table = _table_ref_of(file_name, root, known)
        # Both are interpolated into quoted identifiers; a name that doesn't yield
        # a plain identifier is skipped rather than risking a broken (or injected)
        # CREATE VIEW.
        if _SAFE_IDENT.fullmatch(table) is None:
            continue
        if schema is not None and _SAFE_IDENT.fullmatch(schema) is None:
            schema = None
        groups.setdefault((schema, table), []).append(path)
    return groups


def group_parquet_tables(
    files: list[tuple[str, str]], known: list[str]
) -> dict[str, list[str]]:
    """Public view of the table grouping, for callers that need to report which
    table maps to which blob path without opening a connection.

    Keyed by a flat name — `schema.table` when the folder carried module
    directories — because this feeds the table list a client library globs by
    name, where a tuple key has no meaning."""
    return {
        (table if schema is None else f"{schema}.{table}"): paths
        for (schema, table), paths in _group_parquet(files, known).items()
    }


def _reader(paths: list[str]) -> str:
    if len(paths) == 1:
        return f"read_parquet('{_sql_path(paths[0])}')"
    lst = ", ".join(f"'{_sql_path(p)}'" for p in paths)
    return f"read_parquet([{lst}])"


def _attach_parquet_views(
    con: duckdb.DuckDBPyConnection, groups: dict[tuple[str | None, str], list[str]]
) -> None:
    """Expose each Parquet group as a view under the `ext` schema.

    The source's own schemas become one schema each, so `hosp.patients` reads as
    it does in the warehouse; `ext` stays on the search path, which is what keeps
    an unqualified `patients` resolving for every source imported flat."""
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {_ATTACH_ALIAS}")
    for (schema, table), paths in groups.items():
        target = _ATTACH_ALIAS if schema is None else f'"{schema}"'
        if schema is not None:
            con.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
        # OR REPLACE so a warm pooled connection can re-run setup idempotently.
        con.execute(
            f'CREATE OR REPLACE VIEW {target}."{table}" AS '
            f"SELECT * FROM {_reader(paths)}"
        )


def _parquet_search_path(groups: dict[tuple[str | None, str], list[str]]) -> str:
    """Search path for a Parquet folder: `ext` first, then the source's own
    schemas, so a bare table name resolves whether or not the folder carried
    module directories. Sorted, so the winner of a name present in two schemas
    never depends on file order."""
    schemas = sorted({s for s, _ in groups if s is not None})
    return ",".join([_ATTACH_ALIAS, "memory", *(f'"{s}"' for s in schemas)])


def query_parquet_folder(
    files: list[tuple[str, str]], known: list[str], sql: str,
    pool_key: str | None = None, arrow: bool = False,
):
    """Run read-only SQL against a folder of Parquet files exposed as views, one
    per table (mirrors the browser mountFileFolder path). With `pool_key`, the
    connection (views created) is kept warm across calls."""
    groups = _group_parquet(files, known)
    search_path = _parquet_search_path(groups)

    def _setup() -> duckdb.DuckDBPyConnection:
        con = duckdb.connect()
        con.execute(f"SET extension_directory = '{_ext_dir()}'")
        _attach_parquet_views(con, groups)
        _forbid_file_access(con, [p for paths in groups.values() for p in paths])
        _lock_down_user_sql(con)
        return con

    if pool_key is None:
        con = _setup()
        try:
            return _run_isolated(con, search_path, sql, arrow)
        finally:
            con.close()

    return connection_pool.run_pooled(
        pool_key, _setup, lambda con: _run_isolated(con, search_path, sql, arrow)
    )


def _source_setup(
    config: dict,
    password: str | None,
    files: list[tuple[str, str]] | None,
    known: list[str] | None,
) -> tuple[Callable[[], duckdb.DuckDBPyConnection], str, list[str]]:
    """Return (setup, search_path, readable): a setup that connects to the source
    and makes its tables resolvable by bare name — the same wiring query_external/
    query_file/query_parquet_folder use, factored out so materialize_parquet can
    reuse it — and the files its views read lazily, which must stay readable once
    file access is cut (an attached database stays readable on its own)."""
    engine = config.get("engine")
    if engine in EXTERNAL_ENGINES:
        spec = _engine_spec(config)
        scope = _scope(config)

        def _setup_ext() -> duckdb.DuckDBPyConnection:
            con = _connect(spec["extension"])
            _attach(con, config, password)
            return con

        return _setup_ext, f"memory,{_ATTACH_ALIAS}.{scope}", []

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

        return (
            _setup_pq, _parquet_search_path(groups),
            [p for paths in groups.values() for p in paths],
        )

    path = files[0][1]

    def _setup_file() -> duckdb.DuckDBPyConnection:
        con = duckdb.connect()
        con.execute(f"SET extension_directory = '{_ext_dir()}'")
        _attach_file(con, str(engine), path)
        return con

    return _setup_file, f"memory,{_ATTACH_ALIAS}", []


_SELECT_HEAD = re.compile(r"(SELECT|WITH)\b", re.IGNORECASE)


def _single_query(sql: str) -> str:
    """`sql` if it is exactly one SELECT (or WITH … SELECT), else ValueError.

    It is spliced into `COPY (…) TO`, and `allowed_paths` lets the connection write
    the source's own files as well as read them: a second statement, or a query
    that closes the parenthesis itself (`SELECT 1) TO '<source file>' … --`), would
    overwrite shared data. DuckDB's own parser has the last word — a statement it
    reads as one complete SELECT cannot reach past the parenthesis around it."""
    statements = _split_statements(sql)
    if len(statements) != 1 or not _SELECT_HEAD.match(_strip_leading_noise(statements[0])):
        raise ValueError("the query must be a single SELECT")
    with duckdb.connect() as parser:
        parsed = parser.extract_statements(statements[0])
    if len(parsed) != 1 or parsed[0].type != duckdb.StatementType.SELECT:
        raise ValueError("the query must be a single SELECT")
    return statements[0]


def materialize_parquet(
    config: dict,
    password: str | None,
    files: list[tuple[str, str]] | None,
    known: list[str] | None,
    select_sql: str,
    dest_path: str,
    views: dict[str, tuple[str, list[str]]] | None = None,
    pushdown: bool = False,
) -> None:
    """Run `select_sql` against the source and write the full result to a Parquet
    file at `dest_path`, via a one-shot (non-pooled) connection.

    `views` maps a view name to (its SELECT, the files it reads): created before
    the connection is cut off the filesystem, those files staying readable. The
    COPY is cancellable like a read query (`query_cancel`).

    Non-pooled on purpose: this can be a long full scan, and using the source's
    pooled connection (keyed by source id) would serialise — and thus block — every
    normal page query on that source for the whole materialization. A throwaway
    connection lets refresh run alongside reads.

    Written to a temp file then atomically renamed over `dest_path`, so concurrent
    readers always see either the previous complete cache or the new one — never a
    half-written file.

    `pushdown`: let an external database compute the query (see query_external).
    """
    select_sql = _single_query(select_sql)
    setup, search_path, readable = _source_setup(config, password, files, known)
    dest = Path(dest_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + f".tmp-{os.getpid()}-{uuid.uuid4().hex}")
    con = setup()
    try:
        view_files: list[str] = []
        for name, (view_sql, files_read) in (views or {}).items():
            con.execute(f'CREATE VIEW memory.main."{name}" AS {view_sql}')
            view_files.extend(files_read)
        _forbid_file_access(con, [*readable, *view_files, tmp.as_posix()])
        _lock_down_user_sql(con)
        con.execute(f"SET search_path='{search_path}'")

        def _copy(query: str) -> None:
            with query_cancel.tracking(con):
                con.execute(f"COPY (\n{query}\n) TO '{_sql_path(tmp.as_posix())}' (FORMAT PARQUET)")

        if pushdown and config.get("engine") in EXTERNAL_ENGINES:
            _with_pushdown(con, config, password, select_sql, _copy, bulk=True)
        else:
            _copy(select_sql)
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
            f"CREATE VIEW concepts AS SELECT * FROM read_parquet('{_sql_path(path)}')"
        )
        _reject_session_statements(sql)
        _forbid_file_access(con, [path])
        _lock_down_user_sql(con)
        return _run_statements(con, "memory", sql)
    finally:
        con.close()


def introspect_parquet_folder(
    files: list[tuple[str, str]], known: list[str]
) -> list[dict]:
    """Tables + columns for a folder of Parquet files (one table per group).

    A table from a schema directory is reported as `schema.table`: two modules may
    hold the same table name, and a flat list would show one of them twice."""
    groups = _group_parquet(files, known)
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    result: list[dict] = []
    try:
        for (schema, table), paths in groups.items():
            cols = con.execute(f"DESCRIBE SELECT * FROM {_reader(paths)}").fetchall()
            result.append(
                {
                    "name": table if schema is None else f"{schema}.{table}",
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

            # Files already attached, by absolute path -> the database name holding
            # them. DuckDB refuses to attach one FILE twice however it is aliased,
            # so a role pointing at an already-attached file is aliased instead.
            attached: dict[str, str] = {_real_path(target_path): "target"}
            readable: list[str] = []
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
                readable.extend(_parquet_role_files(spec))

            sql = _resolve_mapping_refs(sql, mapping_data or {}, tmp)
            readable.extend(os.path.join(tmp, name) for name in os.listdir(tmp))

            # Checked on the FINAL sql, after mapping refs are resolved, so nothing
            # can be smuggled in through a `'mapping.<name>'` substitution.
            _reject_forbidden_statements(sql)
            _reject_copy_to_file(sql)

            # Every legitimate attach is done: the script keeps the attached
            # databases, the parquet files its roles' views read and its mapping
            # CSVs — nothing else on the server's filesystem or network.
            _forbid_file_access(con, readable)
            _lock_down_user_sql(con)

            # Unqualified names must not silently fall back to another attached
            # database: keep the writable target first. The role schemas trail it,
            # so `source.patients` resolves without `patients` alone ever reaching
            # a read-only role.
            search_path = ",".join(["target", "memory", *_role_schema_path(con)])
            _reject_ambiguous_role_refs(sql, _ambiguous_role_tables(con), _shadowing_tables(con))
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


def _role_schema_path(con: duckdb.DuckDBPyConnection) -> list[str]:
    """`catalog.schema` for every schema of the role databases that have more than
    `main`, `main` first.

    A source published as several schemas (MIMIC-IV's `hosp`/`icu`, eHOP's eleven
    Oracle schemas) would otherwise be unreachable through the two-part
    `source.<table>` that the shipped pipelines use everywhere: DuckDB resolves
    that form through the catalog search path, and a role's schemas were never on
    it. Qualifying only reaches `role.schema.table`, so without this a
    multi-schema source breaks ~24 references per pipeline.

    Once one schema of a catalog is on the path, DuckDB looks `role.table` up in
    that catalog's listed schemas ONLY, no longer in its `main`: `main` has to be
    listed too, or a table it holds stops resolving (`vocab.concept` failed as
    soon as the library carried a stray schema). A role with `main` alone stays
    off the path, where `role.table` already reads `main`. A name held by two
    schemas is refused before the run (`_reject_ambiguous_role_refs`), so the
    order never picks a table silently; it is fixed only to keep runs
    reproducible."""
    rows = con.execute(
        "SELECT DISTINCT catalog_name, schema_name FROM information_schema.schemata "
        "WHERE catalog_name NOT IN ('system', 'temp', 'memory', 'target') "
        "AND schema_name NOT IN ('information_schema', 'pg_catalog') "
        "ORDER BY catalog_name, schema_name <> 'main', schema_name"
    ).fetchall()
    schemas: dict[str, list[str]] = {}
    for cat, schema in rows:
        schemas.setdefault(str(cat), []).append(str(schema))
    return [
        f'"{_require_ident(cat, "catalog name")}"."{_require_ident(schema, "schema name")}"'
        for cat, names in schemas.items()
        if names != ["main"]
        for schema in names
    ]


def _ambiguous_role_tables(con: duckdb.DuckDBPyConnection) -> dict[str, dict[str, list[str]]]:
    """Role -> table name -> its schemas, for each name two schemas of one role
    database hold. Lower-cased, as DuckDB matches names."""
    rows = con.execute(
        "SELECT lower(table_catalog), lower(table_name), "
        "list(DISTINCT table_schema ORDER BY table_schema) "
        "FROM information_schema.tables "
        "WHERE table_catalog NOT IN ('system', 'temp', 'memory', 'target') "
        "GROUP BY ALL HAVING count(DISTINCT table_schema) > 1"
    ).fetchall()
    out: dict[str, dict[str, list[str]]] = {}
    for cat, table, schemas in rows:
        out.setdefault(cat, {})[table] = list(schemas)
    return out


def _created_name_positions(texts: list[str]) -> list[int]:
    """Where `CREATE … TABLE|VIEW [x.]name` puts `name`, `texts` lower-cased."""
    out = []
    for i, text in enumerate(texts):
        if text in ("table", "view") and i > 0:
            j = i + 1
            while j < len(texts) and texts[j] in ("if", "not", "exists"):
                j += 1
            while j + 2 < len(texts) and texts[j + 1] == ".":
                j += 2
            if j < len(texts):
                out.append(j)
    return out


def _created_names(tokens: list[tuple[str, "duckdb.token_type"]]) -> set[str]:
    """Lower-cased names a statement creates: a bare reference to one in a LATER
    statement reads that, not a role."""
    texts = [text.strip('"').lower() for text, _ in tokens]
    return {texts[j] for j in _created_name_positions(texts)}


def _cte_names(tokens: list[tuple[str, "duckdb.token_type"]]) -> set[str]:
    """Lower-cased names a statement binds as a CTE (`name AS (`), which only that
    statement sees. `CREATE TABLE name AS (` binds nothing yet."""
    texts = [text.strip('"').lower() for text, _ in tokens]
    created = set(_created_name_positions(texts))
    return {
        texts[i - 1]
        for i, text in enumerate(texts)
        if text == "as" and i > 0 and i - 1 not in created
        and i + 1 < len(texts) and texts[i + 1] in ("(", "materialized")
    }


# Functions whose arguments use FROM as a separator, not as a table clause.
_FROM_ARGUMENT_FUNCTIONS = frozenset({"EXTRACT", "SUBSTRING", "TRIM", "OVERLAY", "POSITION"})


# Keywords that open a query rather than name a table, right after a `(`.
_SUBQUERY_STARTS = frozenset({"SELECT", "WITH", "VALUES", "FROM", "TABLE", "PIVOT", "UNPIVOT"})
# Keywords that end a FROM list at its own nesting level.
_FROM_LIST_ENDS = frozenset({
    "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "QUALIFY", "WINDOW", "UNION",
    "EXCEPT", "INTERSECT", "JOIN", "ON", "USING", "RETURNING", "SET", "SELECT",
})


def _table_list_positions(texts: list[str], start: int) -> list[int]:
    """The table names of the FROM list opening at `start`: the first item, the
    item after each comma of the list, and the same inside `FROM (a, b)`. Commas
    nested deeper (function arguments, column aliases, subqueries) are not items."""
    inner = 1 if texts[start] == "(" and start + 1 < len(texts) and texts[start + 1] not in _SUBQUERY_STARTS else 0
    first = start + inner
    out = [first]
    depth = inner
    for j in range(first + 1, len(texts)):
        text = texts[j]
        if text == "(":
            depth += 1
        elif text == ")":
            depth -= 1
            if depth < 0:
                break
        elif depth == 0 and text in _FROM_LIST_ENDS:
            break
        elif text == "," and depth <= inner and j + 1 < len(texts):
            out.append(j + 1)
    return out


def _table_clause_positions(texts: list[str]) -> list[int]:
    """Indexes of the tokens naming a table in a FROM or JOIN clause — after the
    keyword, after each comma of a FROM list, inside `FROM (t)` — but not after
    `IS [NOT] DISTINCT FROM`, nor the FROM inside `EXTRACT(… FROM …)` and its
    kin."""
    out: set[int] = set()
    openers: list[str] = []
    for i, text in enumerate(texts):
        if i + 1 >= len(texts):
            break
        if text == "(":
            openers.append(texts[i - 1] if i > 0 else "")
        elif text == ")":
            if openers:
                openers.pop()
        elif text == "JOIN":
            out.add(i + 1)
        elif (
            text == "FROM"
            and not (i > 0 and texts[i - 1] == "DISTINCT")
            and not (openers and openers[-1] in _FROM_ARGUMENT_FUNCTIONS)
        ):
            out.update(_table_list_positions(texts, i + 1))
    return sorted(out)


def _shadowing_tables(con: duckdb.DuckDBPyConnection) -> frozenset[str]:
    """Lower-cased tables of the catalogs ahead of the roles on an ETL search path."""
    rows = con.execute(
        "SELECT DISTINCT lower(table_name) FROM information_schema.tables "
        "WHERE table_catalog IN ('target', 'memory') AND table_schema = 'main'"
    ).fetchall()
    return frozenset(name for (name,) in rows)


def _reject_ambiguous_role_refs(
    sql: str, ambiguous: dict[str, dict[str, list[str]]], shadowed: frozenset[str] = frozenset(),
) -> None:
    """Refuse a two-part `role.table` whose table two schemas of that role hold,
    and a bare `FROM|JOIN table` that two schemas of one role hold, unless a table
    of that name sits ahead of the roles on the search path (`shadowed`: the
    target's and memory's), an earlier statement creates it or a CTE of the
    statement binds it.

    The search path would resolve it to whichever schema comes first, reading one
    module's table where the author may have meant the other's. The script has to
    name the schema instead. Tokenized, so a literal or a comment never matches."""
    if not ambiguous:
        return
    names = (duckdb.token_type.identifier, duckdb.token_type.keyword)
    created = set(shadowed)
    for tokens in (_token_texts(stmt) for stmt in _split_statements(sql)):
        texts = [text for text, _ in tokens]
        defined = created | _cte_names(tokens)
        created |= _created_names(tokens)
        for i in _table_clause_positions(texts):
            if tokens[i][1] not in names:
                continue
            if i + 1 < len(tokens) and texts[i + 1] in (".", "("):
                continue
            table = texts[i].strip('"').lower()
            if table in defined:
                continue
            for role, tables in ambiguous.items():
                schemas = tables.get(table)
                if schemas:
                    options = " or ".join(f"{role}.{schema}.{table}" for schema in schemas)
                    raise ValueError(
                        f"{table} is ambiguous: {', '.join(schemas)} of {role} each hold a "
                        f"table {table}. Name the schema: {options}."
                    )
        for i in range(len(tokens) - 2):
            if tokens[i][1] not in names or tokens[i + 2][1] not in names:
                continue
            if texts[i + 1] != "." or (i > 0 and texts[i - 1] == "."):
                continue
            if i + 3 < len(tokens) and texts[i + 3] == ".":
                continue
            role = texts[i].strip('"').lower()
            table = texts[i + 2].strip('"').lower()
            schemas = ambiguous.get(role, {}).get(table)
            if schemas:
                options = " or ".join(f"{role}.{schema}.{table}" for schema in schemas)
                raise ValueError(
                    f"{role}.{table} is ambiguous: {', '.join(schemas)} each hold a "
                    f"table {table}. Name the schema: {options}."
                )


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


def _parquet_role_files(spec: dict) -> list[str]:
    """The files a parquet role's views read lazily, which must stay readable once
    the run is cut off the filesystem. Empty for any other kind of role."""
    if spec.get("kind") != "parquet":
        return []
    groups = _group_parquet(spec.get("files") or [], spec.get("known") or [])
    return [p for paths in groups.values() for p in paths]


def _attach_role(con: duckdb.DuckDBPyConnection, role: str, spec: dict) -> None:
    """ATTACH one role database read-only under its role name.

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
        for (schema, table), paths in groups.items():
            safe_table = _require_ident(table, "parquet table name")
            # A folder laid out per module keeps its schemas, so `source.hosp.t`
            # works and two modules can hold the same table name. Without one the
            # view lands in main, where `source.t` has always found it.
            safe_schema = "main" if schema is None else _require_ident(schema, "schema name")
            if safe_schema != "main":
                con.execute(f'CREATE SCHEMA IF NOT EXISTS "{role}"."{safe_schema}"')
            con.execute(
                f'CREATE OR REPLACE VIEW "{role}"."{safe_schema}"."{safe_table}" '
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
        _attach_external(con, role, spec["config"], spec.get("password"))
        return
    raise ValueError(f"cannot attach role {role!r}: unknown kind {kind!r}")
