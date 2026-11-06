"""Admin-only read-only access to the application's OWN database.

Powers the Settings → Application database "Query database" tool: run a single
read-only SELECT and introspect the schema of the app DB itself (SQLite or
Postgres), reached through the SQLAlchemy async engine — not the DuckDB ATTACH
path used for external data sources.

Read-only is enforced by the database itself: the statement runs on a connection
switched to read-only (SQLite `PRAGMA query_only`, otherwise a READ ONLY
transaction), which is always rolled back. A statement that starts with SELECT or
WITH does not have to be a read (SQLite accepts `WITH … UPDATE`), so the keyword
check below only gives a clear message early; it is not the barrier. Gated by the global
"app-database:read" permission (admin-only by default) because the app DB holds
every table, including password hashes and encrypted connection secrets.
"""

import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit
from app.core.database import describe_app_database, get_db
from app.core.permissions import require_global_permission
from app.models.user import User
from app.schemas.auth import DbInfoResponse
from app.schemas.data_source import (
    IntrospectedColumn,
    IntrospectedTable,
    QueryRequest,
    QueryResult,
)

router = APIRouter(prefix="/database", tags=["database"])

# Same cap external data-source queries use — a SELECT * on a huge table would
# otherwise stream everything back.
MAX_QUERY_ROWS = 10_000


def _is_single_read_statement(sql: str) -> bool:
    """True if `sql` is exactly one read-only statement (SELECT or WITH ... SELECT).

    Strips line/block comments and rejects a trailing second statement so a
    read-only query can't smuggle a write after a semicolon."""
    stripped = _strip_comments(sql).strip().rstrip(";").strip()
    if not stripped:
        return False
    # A single statement has no inner semicolon once the trailing one is removed.
    if ";" in stripped:
        return False
    head = stripped[:6].lower()
    return head.startswith("select") or stripped[:4].lower().startswith("with")


def _strip_comments(sql: str) -> str:
    out = []
    i, n = 0, len(sql)
    while i < n:
        two = sql[i : i + 2]
        if two == "--":
            nl = sql.find("\n", i)
            i = n if nl == -1 else nl + 1
        elif two == "/*":
            end = sql.find("*/", i + 2)
            i = n if end == -1 else end + 2
        elif sql[i] == "'":  # skip string literal (may contain ; or --)
            i += 1
            while i < n:
                if sql[i] == "'" and sql[i + 1 : i + 2] == "'":
                    i += 2
                elif sql[i] == "'":
                    i += 1
                    break
                else:
                    i += 1
        else:
            out.append(sql[i])
            i += 1
    return "".join(out)


def _jsonable(value):
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        return value.hex()
    return value


@router.get("/info", response_model=DbInfoResponse)
async def app_database_info(
    _user: User = Depends(require_global_permission("app-database:read")),
):
    """Engine and location of the app database, as set by LINKR_DATABASE_URL / LINKR_DATA_DIR."""
    engine, location = describe_app_database()
    return DbInfoResponse(engine=engine, location=location)


@router.post("/query", response_model=QueryResult)
async def query_app_database(
    body: QueryRequest,
    _user: User = Depends(require_global_permission("app-database:read")),
    db: AsyncSession = Depends(get_db),
):
    """Run a single read-only SELECT against the app's own database."""
    if not _is_single_read_statement(body.sql):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Only a single read-only SELECT (or WITH … SELECT) statement is allowed.",
        )
    audit.bind(action="query", detail=body.sql)
    # Start a fresh transaction: a READ ONLY mode must be set before its first query.
    await db.rollback()
    conn = await db.connection()
    is_sqlite = conn.dialect.name == "sqlite"
    await conn.exec_driver_sql("PRAGMA query_only = ON" if is_sqlite else "SET TRANSACTION READ ONLY")
    try:
        result = await conn.execute(text(body.sql))
        cols = list(result.keys())
        rows = [
            {c: _jsonable(v) for c, v in zip(cols, row)}
            for row in result.fetchmany(MAX_QUERY_ROWS)
        ]
    except Exception as e:  # noqa: BLE001 — surface the DB error to the admin UI
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e))
    finally:
        # query_only belongs to the pooled connection, not the transaction: it must
        # be lifted before the connection goes back to the pool, or the connection
        # is discarded.
        if is_sqlite:
            try:
                await conn.exec_driver_sql("PRAGMA query_only = OFF")
            except Exception:  # noqa: BLE001
                await conn.invalidate()
        await db.rollback()
    audit.bind(row_count=len(rows))
    return QueryResult(rows=rows)


@router.get("/schema", response_model=list[IntrospectedTable])
async def app_database_schema(
    _user: User = Depends(require_global_permission("app-database:read")),
    db: AsyncSession = Depends(get_db),
):
    """Tables + columns of the app's own database (engine-agnostic reflection)."""

    def _reflect(sync_conn) -> list[IntrospectedTable]:
        insp = inspect(sync_conn)
        tables: list[IntrospectedTable] = []
        for name in sorted(insp.get_table_names()):
            columns = [
                IntrospectedColumn(
                    name=col["name"],
                    type=str(col["type"]),
                    nullable=bool(col.get("nullable", True)),
                )
                for col in insp.get_columns(name)
            ]
            tables.append(IntrospectedTable(name=name, columns=columns))
        return tables

    conn = await db.connection()
    return await conn.run_sync(_reflect)
