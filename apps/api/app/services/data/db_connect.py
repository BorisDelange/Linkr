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


def _split_statements(sql: str) -> list[str]:
    """Split SQL on semicolons, ignoring those inside single-quoted strings and
    line comments. Mirrors the frontend's splitSqlStatements so multi-statement
    scripts (CREATE VIEW …; SELECT …;) behave the same server-side."""
    stmts: list[str] = []
    current = ""
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":
            current += ch
            i += 1
            while i < n:
                if sql[i] == "'" and i + 1 < n and sql[i + 1] == "'":
                    current += "''"
                    i += 2
                elif sql[i] == "'":
                    current += "'"
                    i += 1
                    break
                else:
                    current += sql[i]
                    i += 1
        elif ch == "-" and i + 1 < n and sql[i + 1] == "-":
            nl = sql.find("\n", i)
            i = n if nl == -1 else nl + 1
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


def _run_statements(
    con: duckdb.DuckDBPyConnection, search_path: str, sql: str,
    max_rows: int | None = MAX_QUERY_ROWS,
) -> list[dict]:
    """Execute each statement in `sql` sequentially, returning the last result's
    rows. `search_path` puts DuckDB's writable `memory` catalog first (so CREATE
    VIEW / temp tables land there) then the read-only attached source for reads.

    `max_rows` caps the payload (a `SELECT *` on a billion-row table would blow
    up the response). Pass `None` for internal server-side consumers that need
    the full result (e.g. materializing the cross-project table cache)."""
    con.execute(f"SET search_path='{search_path}'")
    result: duckdb.DuckDBPyConnection | None = None
    for stmt in _split_statements(sql):
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
        # block INSTALL/LOAD of unknown/community extensions and lock the config
        # so the query can't re-enable anything. NOTE: DuckDB 1.5 cannot confine
        # the local filesystem once the DB is running (allowed_directories can't
        # be set at/after connect and enable_external_access can't be toggled),
        # so this does NOT sandbox arbitrary local-file reads — that residual is
        # accepted because /query is now editor-only, and editors already hold
        # ide:execute (Python/R/SQL IDE) in this app.
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
        groups.setdefault(_table_of(file_name, known), []).append(path)
    return groups


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
