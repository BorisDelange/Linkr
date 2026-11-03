"""Where a cohort derivation writes, engine by engine — the target, and the
database that receives the correspondence table.

Every writer is handed only statements cohort_derive builds (identifiers checked
there) and runs them its engine's way:

- **DuckDB file, Postgres**: attached writable in DuckDB, `CREATE TABLE … AS`.
- **SQL Server**: attached writable through the `mssql` extension — the same SQL,
  but no `DROP SCHEMA … CASCADE` (its tables go first) and no `DELETE` on a table
  without a primary key (sent as T-SQL through `mssql_exec`).
- **Doris**: attached through the `mysql` extension for the DDL, the rows sent by
  Stream Load — Doris' bulk-load API, Parquet over HTTP: a million rows in a
  fraction of a second, where the MySQL protocol inserts a few thousand a second.
- **Oracle**: python-oracledb, since the `oracle_scanner` extension issues no DDL.
  A schema is a user there, which only a DBA creates: Linkr writes into an
  existing, empty schema given to it, and empties it on a rebuild. The rows go by
  direct path load from DuckDB's Arrow batches.

The SQL Server, Doris and Oracle logins used here are the user's **write**
logins: their read logins are checked read-only at every attach, and stay so.
"""

from __future__ import annotations

import base64
import contextlib
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

import duckdb

from app.services.data import community_engines
from app.services.data.db_connect import _dsn, _engine_spec, _require_ident, _sql_path, attach_dsn
from app.services.data.db_host_guard import check_db_host

# Rows per Arrow batch sent to Oracle, and per Parquet file sent to Doris.
ORACLE_BATCH_ROWS = 100_000
DORIS_FILE_BYTES = "512MB"


@dataclass
class Destination:
    """What `writer_for` needs: a DuckDB file (`path`) or an external database
    (`config`, `password`), as cohort_derive.TargetSpec carries them."""

    kind: str
    path: str | None = None
    config: dict | None = None
    password: str | None = None


def engine_of(dest: Destination) -> str:
    return "duckdb" if dest.kind == "file" else str((dest.config or {}).get("engine") or "")


def writer_for(con: duckdb.DuckDBPyConnection, dest: Destination, alias: str) -> Writer:
    """Open `dest` for writing, under `alias` in `con` when it goes through DuckDB."""
    engine = engine_of(dest)
    if dest.kind == "file":
        con.execute(f"ATTACH '{_sql_path(dest.path)}' AS {alias}")
        return Writer(con, alias)
    if dest.kind != "external":
        raise ValueError(f"unknown target kind {dest.kind!r}")
    if engine == "oracle":
        return OracleWriter(con, dest.config, dest.password)
    if engine == "sqlserver":
        community_engines.attach_writable(con, alias, dest.config, dest.password)
        return SqlServerWriter(con, alias)
    spec = _engine_spec(dest.config)
    con.execute(f"INSTALL {spec['extension']}")
    con.execute(f"LOAD {spec['extension']}")
    # Writable, deliberately: the one place Linkr writes into a database it did
    # not create, and only statements cohort_derive generates run.
    attach_dsn(con, _dsn(dest.config, dest.password), alias, f"TYPE {spec['type']}")
    if engine == "doris":
        return DorisWriter(con, alias, dest.config, dest.password)
    if engine == "postgresql":
        return Writer(con, alias)
    raise ValueError(f"Linkr cannot derive into a {engine} database")


def _q(name: str, what: str = "name") -> str:
    return f'"{_require_ident(name, what)}"'


class Writer:
    """A destination attached in DuckDB as `alias` (a DuckDB file, Postgres)."""

    def __init__(self, con: duckdb.DuckDBPyConnection, alias: str):
        self.con = con
        self.alias = alias

    def ref(self, schema: str, table: str) -> str:
        return f"{self.alias}.{_q(schema, 'schema name')}.{_q(table, 'table name')}"

    def create_schema(self, schema: str, exist_ok: bool = False) -> None:
        exists = " IF NOT EXISTS" if exist_ok else ""
        self.con.execute(f"CREATE SCHEMA{exists} {self.alias}.{_q(schema, 'schema name')}")

    def drop_schema(self, schema: str) -> None:
        self.con.execute(f"DROP SCHEMA IF EXISTS {self.alias}.{_q(schema, 'schema name')} CASCADE")

    def create_table_as(self, schema: str, table: str, select: str) -> int:
        dest = self.ref(schema, table)
        self.con.execute(f"CREATE TABLE {dest} AS {select}")
        return int(self.con.execute(f"SELECT COUNT(*) FROM {dest}").fetchone()[0])

    def ensure_table(self, schema: str, table: str, columns: list[tuple[str, str]]) -> None:
        cols = ", ".join(f"{_q(c, 'column name')} {t}" for c, t in columns)
        self.con.execute(f"CREATE TABLE IF NOT EXISTS {self.ref(schema, table)} ({cols})")

    def delete_where(self, schema: str, table: str, column: str, value: str) -> None:
        self.con.execute(f"DELETE FROM {self.ref(schema, table)} WHERE {_q(column, 'column name')} = ?", [value])

    def insert_select(self, schema: str, table: str, select: str, params: list | None = None) -> None:
        self.con.execute(f"INSERT INTO {self.ref(schema, table)} {select}", params or [])

    def checkpoint(self) -> None:
        """Make what was written durable before the connection closes: a DuckDB
        file's log is folded into it. The servers commit each statement."""
        if self.con.execute(
            "SELECT type FROM duckdb_databases() WHERE database_name = ?", [self.alias],
        ).fetchone()[0] == "duckdb":
            self.con.execute(f"CHECKPOINT {self.alias}")

    def close(self) -> None:
        """Release what the writer holds besides `con` (which its caller closes)."""


def _tsql_literal(value: str) -> str:
    return "N'" + value.replace("'", "''") + "'"


class SqlServerWriter(Writer):
    def drop_schema(self, schema: str) -> None:
        _require_ident(schema, "schema name")
        tables = self.con.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_catalog = ? AND table_schema = ?",
            [self.alias, schema],
        ).fetchall()
        for (table,) in tables:
            self.con.execute(f"DROP TABLE {self.ref(schema, str(table))}")
        exists = self.con.execute(
            "SELECT COUNT(*) FROM duckdb_schemas() WHERE database_name = ? AND schema_name = ?",
            [self.alias, schema],
        ).fetchone()[0]
        if exists:
            self.con.execute(f"DROP SCHEMA {self.alias}.{_q(schema, 'schema name')}")

    def delete_where(self, schema: str, table: str, column: str, value: str) -> None:
        # The extension deletes only from a table with a primary key: T-SQL, sent
        # as it is. Every name is a checked identifier, the value a literal.
        sql = (
            f"DELETE FROM [{_require_ident(schema, 'schema name')}].[{_require_ident(table, 'table name')}] "
            f"WHERE [{_require_ident(column, 'column name')}] = {_tsql_literal(value)}"
        )
        self.con.execute("SELECT mssql_exec(?, ?)", [self.alias, sql])


class DorisWriter(Writer):
    def __init__(self, con: duckdb.DuckDBPyConnection, alias: str, config: dict, password: str | None):
        super().__init__(con, alias)
        self.config = config
        self.password = password or ""
        self.tmp = Path(tempfile.mkdtemp(prefix="derive-doris-", dir=_scratch_dir()))

    def _execute(self, sql: str) -> None:
        self.con.execute("CALL mysql_execute(?, ?)", [self.alias, sql])
        self.con.execute("CALL mysql_clear_cache()")

    def create_schema(self, schema: str, exist_ok: bool = False) -> None:
        # As Doris SQL: the extension's IF NOT EXISTS misses a database it did
        # not see created, and sends a plain CREATE that fails.
        exists = "IF NOT EXISTS " if exist_ok else ""
        self._execute(f"CREATE DATABASE {exists}`{_require_ident(schema, 'schema name')}`")

    def drop_schema(self, schema: str) -> None:
        self._execute(f"DROP DATABASE IF EXISTS `{_require_ident(schema, 'schema name')}`")

    def _create(self, schema: str, table: str, columns: list[tuple[str, str]], exist_ok: bool = False) -> None:
        # Written here rather than by the extension: Doris makes a table's first
        # columns its sort key unless told otherwise, and refuses a text or
        # floating-point one — so no key at all, as a copy needs none.
        cols = ", ".join(f"`{_require_ident(c, 'column name')}` {_doris_type(t)}" for c, t in columns)
        exists = "IF NOT EXISTS " if exist_ok else ""
        self._execute(
            f"CREATE TABLE {exists}`{_require_ident(schema, 'schema name')}`.`{_require_ident(table, 'table name')}` "
            f"({cols}) DISTRIBUTED BY RANDOM BUCKETS AUTO "
            "PROPERTIES (\"enable_duplicate_without_keys_by_default\" = \"true\")"
        )

    def ensure_table(self, schema: str, table: str, columns: list[tuple[str, str]]) -> None:
        self._create(schema, table, columns, exist_ok=True)

    def create_table_as(self, schema: str, table: str, select: str) -> int:
        # The table from the SELECT's own columns, empty; the rows by Stream Load.
        described = self.con.execute(f"DESCRIBE SELECT * FROM ({select})").fetchall()
        self._create(schema, table, [(str(c[0]), str(c[1])) for c in described])
        out = self.tmp / table
        out.mkdir()
        self.con.execute(
            f"COPY ({select}) TO '{_sql_path(str(out))}' "
            f"(FORMAT parquet, FILE_SIZE_BYTES '{DORIS_FILE_BYTES}', PER_THREAD_OUTPUT false)"
        )
        loaded = sum(self._stream_load(schema, table, f) for f in sorted(out.rglob("*.parquet")))
        shutil.rmtree(out, ignore_errors=True)
        self.con.execute("CALL mysql_clear_cache()")
        return loaded

    def insert_select(self, schema: str, table: str, select: str, params: list | None = None) -> None:
        out = self.tmp / f"insert-{table}.parquet"
        self.con.execute(f"COPY ({select}) TO '{_sql_path(str(out))}' (FORMAT parquet)", params or [])
        self._stream_load(schema, table, out)
        out.unlink(missing_ok=True)
        self.con.execute("CALL mysql_clear_cache()")

    def _stream_load(self, schema: str, table: str, parquet: Path) -> int:
        import httpx

        host = self.config.get("host") or ""
        check_db_host(host)
        port = int(self.config.get("httpPort") or 8030)
        url = f"http://{host}:{port}/api/{_require_ident(schema, 'schema name')}/{_require_ident(table, 'table name')}/_stream_load"
        auth = base64.b64encode(f"{self.config.get('username') or ''}:{self.password}".encode()).decode()
        headers = {"Authorization": f"Basic {auth}", "format": "parquet", "Expect": "100-continue"}
        body = parquet.read_bytes()
        with httpx.Client(timeout=None) as client:
            r = client.put(url, content=body, headers=headers)
            # The frontend answers with the backend that takes the load. httpx drops
            # the credentials on a redirect to another host: sent again, as Doris
            # documents for every client (curl's --location-trusted).
            for _ in range(3):
                if r.status_code not in (301, 302, 307, 308):
                    break
                r = client.put(r.headers["location"], content=body, headers=headers)
        try:
            result = r.json()
        except ValueError:
            raise ValueError(f"Doris Stream Load answered {r.status_code}: {r.text[:300]}") from None
        if result.get("Status") not in ("Success", "Publish Timeout"):
            raise ValueError(f"Doris Stream Load into {schema}.{table} failed: {result.get('Message') or result}")
        return int(result.get("NumberLoadedRows") or 0)

    def close(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


def _doris_type(duck_type: str) -> str:
    t = duck_type.upper()
    if t.startswith("DECIMAL"):
        return t
    return {
        "BOOLEAN": "BOOLEAN", "TINYINT": "TINYINT", "SMALLINT": "SMALLINT", "INTEGER": "INT", "BIGINT": "BIGINT",
        "HUGEINT": "LARGEINT", "UTINYINT": "SMALLINT", "USMALLINT": "INT", "UINTEGER": "BIGINT", "UBIGINT": "LARGEINT",
        "FLOAT": "FLOAT", "DOUBLE": "DOUBLE", "DATE": "DATE", "TIMESTAMP": "DATETIME(6)", "TIMESTAMP_NS": "DATETIME(6)",
        "TIMESTAMP_MS": "DATETIME(3)", "TIMESTAMP_S": "DATETIME", "TIMESTAMP WITH TIME ZONE": "DATETIME(6)",
    }.get(t, "STRING")


def _scratch_dir() -> str:
    """Where the Parquet files sent to Doris wait: Linkr's own data folder, since
    they hold patient rows — never the system's temporary folder."""
    from app.config import settings

    path = settings.data_path / "_derive_tmp"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


# DuckDB type → Oracle column type. What has no counterpart is sent as text.
_ORACLE_TYPES = {
    "BOOLEAN": "NUMBER(1)", "TINYINT": "NUMBER(3)", "SMALLINT": "NUMBER(5)", "INTEGER": "NUMBER(10)",
    "BIGINT": "NUMBER(19)", "HUGEINT": "NUMBER(38)", "UTINYINT": "NUMBER(3)", "USMALLINT": "NUMBER(5)",
    "UINTEGER": "NUMBER(10)", "UBIGINT": "NUMBER(20)", "FLOAT": "BINARY_FLOAT", "DOUBLE": "BINARY_DOUBLE",
    "DATE": "DATE", "TIMESTAMP": "TIMESTAMP", "TIMESTAMP_NS": "TIMESTAMP(9)", "TIMESTAMP_MS": "TIMESTAMP(3)",
    "TIMESTAMP_S": "TIMESTAMP(0)", "TIMESTAMP WITH TIME ZONE": "TIMESTAMP WITH TIME ZONE", "BLOB": "BLOB",
}
# Past this many characters a text column is a CLOB: VARCHAR2 holds 4000 bytes.
_VARCHAR2_CHARS = 1000


class OracleWriter:
    """An existing Oracle schema, written with python-oracledb. Names go in upper
    case, as Oracle folds them (Linkr reads them back in lower case)."""

    def __init__(self, con: duckdb.DuckDBPyConnection, config: dict, password: str | None):
        from app.services.data import oracle_client

        if oracle_client.oracledb is None:
            raise ValueError("the python-oracledb driver is not installed on this server")
        self.con = con
        self.conn = oracle_client.oracledb.connect(
            user=config.get("username"), password=password or "", dsn=oracle_client._dsn(config),
        )
        self.cur = self.conn.cursor()

    @staticmethod
    def _name(name: str, what: str) -> str:
        return _require_ident(name, what).upper()

    def _tables(self, owner: str) -> list[str]:
        self.cur.execute("SELECT table_name FROM all_tables WHERE owner = :o", o=owner)
        return [r[0] for r in self.cur.fetchall()]

    def create_schema(self, schema: str, exist_ok: bool = False) -> None:
        owner = self._name(schema, "schema name")
        self.cur.execute("SELECT COUNT(*) FROM all_users WHERE username = :o", o=owner)
        if not self.cur.fetchone()[0]:
            raise ValueError(
                f"there is no Oracle schema {owner}: Oracle has no schema but a user's, so an administrator "
                "creates one for the derivation and gives Linkr's write account its rights there"
            )
        if not exist_ok and self._tables(owner):
            raise ValueError(f"the Oracle schema {owner} already holds tables: derive into an empty one")

    def drop_schema(self, schema: str) -> None:
        # The schema is the derivation's own: emptied, never dropped (a user).
        owner = self._name(schema, "schema name")
        for table in self._tables(owner):
            self.cur.execute(f'DROP TABLE "{owner}"."{table}" PURGE')

    def _columns(self, select: str) -> list[tuple[str, str, str]]:
        """(name, DuckDB type, Oracle type) for each column of `select`."""
        described = self.con.execute(f"DESCRIBE SELECT * FROM ({select})").fetchall()
        texts = [str(c[0]) for c in described if str(c[1]).upper() == "VARCHAR"]
        longest: dict[str, int] = {}
        if texts:
            row = self.con.execute(
                "SELECT " + ", ".join(f'max(length("{_require_ident(c, "column name")}"))' for c in texts)
                + f" FROM ({select})"
            ).fetchone()
            longest = {c: int(v or 0) for c, v in zip(texts, row)}
        out = []
        for name, duck_type, *_ in described:
            t = str(duck_type).upper()
            if t == "VARCHAR":
                ora = "CLOB" if longest.get(str(name), 0) > _VARCHAR2_CHARS else f"VARCHAR2({_VARCHAR2_CHARS} CHAR)"
            elif t.startswith("DECIMAL"):
                ora = "NUMBER" + t[len("DECIMAL"):]
            else:
                ora = _ORACLE_TYPES.get(t, "CLOB")
            out.append((str(name), t, ora))
        return out

    @staticmethod
    def _cast(columns: list[tuple[str, str, str]], select: str) -> str:
        """`select` with what Arrow cannot hand Oracle as it is cast: a boolean to
        a number, anything with no Oracle counterpart to text."""
        parts = []
        for name, duck_type, ora in columns:
            col = f'"{_require_ident(name, "column name")}"'
            if duck_type == "BOOLEAN":
                parts.append(f"CAST({col} AS TINYINT) AS {col}")
            elif ora == "CLOB" and duck_type != "VARCHAR":
                parts.append(f"CAST({col} AS VARCHAR) AS {col}")
            else:
                parts.append(col)
        return f"SELECT {', '.join(parts)} FROM ({select})"

    def _load(self, owner: str, table: str, columns: list[tuple[str, str, str]], select: str, params=None) -> int:
        reader = self.con.execute(self._cast(columns, select), params or []).fetch_record_batch(ORACLE_BATCH_ROWS)
        names = [c[0].upper() for c in columns]
        loaded = 0
        for batch in reader:
            if batch.num_rows:
                self.conn.direct_path_load(schema_name=owner, table_name=table, column_names=names, data=batch)
                loaded += batch.num_rows
        return loaded

    def create_table_as(self, schema: str, table: str, select: str) -> int:
        owner, name = self._name(schema, "schema name"), self._name(table, "table name")
        columns = self._columns(select)
        cols = ", ".join(f'"{c[0].upper()}" {c[2]}' for c in columns)
        self.cur.execute(f'CREATE TABLE "{owner}"."{name}" ({cols})')
        return self._load(owner, name, columns, select)

    def ensure_table(self, schema: str, table: str, columns: list[tuple[str, str]]) -> None:
        owner, name = self._name(schema, "schema name"), self._name(table, "table name")
        if name in self._tables(owner):
            return
        types = {"VARCHAR": f"VARCHAR2({_VARCHAR2_CHARS} CHAR)", **_ORACLE_TYPES}
        cols = ", ".join(f'"{self._name(c, "column name")}" {types.get(t.upper(), "CLOB")}' for c, t in columns)
        self.cur.execute(f'CREATE TABLE "{owner}"."{name}" ({cols})')

    def delete_where(self, schema: str, table: str, column: str, value: str) -> None:
        owner, name = self._name(schema, "schema name"), self._name(table, "table name")
        self.cur.execute(f'DELETE FROM "{owner}"."{name}" WHERE "{self._name(column, "column name")}" = :v', v=value)
        self.conn.commit()

    def insert_select(self, schema: str, table: str, select: str, params: list | None = None) -> None:
        owner, name = self._name(schema, "schema name"), self._name(table, "table name")
        described = self.con.execute(f"DESCRIBE SELECT * FROM ({select})", params or []).fetchall()
        columns = [(str(c[0]), str(c[1]).upper(), "") for c in described]
        self._load(owner, name, columns, select, params)

    def checkpoint(self) -> None:
        self.conn.commit()

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self.cur.close()
        with contextlib.suppress(Exception):
            self.conn.close()
