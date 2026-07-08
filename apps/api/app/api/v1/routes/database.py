"""Admin-only read-only access to the application's OWN database.

Powers the Settings → Application database "Query database" tool: run a single
read-only SELECT and introspect the schema of the app DB itself (SQLite or
Postgres), reached through the SQLAlchemy async engine — not the DuckDB ATTACH
path used for external data sources.

Read-only is enforced two ways: only a single SELECT/WITH statement is accepted,
and it runs in a transaction that is always rolled back, so nothing can be
written even if a driver would otherwise allow it. Admin-only because the app DB
holds every table, including password hashes and encrypted connection secrets.
"""

import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_admin
from app.models.user import User
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


@router.post("/query", response_model=QueryResult)
async def query_app_database(
    body: QueryRequest,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Run a single read-only SELECT against the app's own database."""
    if not _is_single_read_statement(body.sql):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Only a single read-only SELECT (or WITH … SELECT) statement is allowed.",
        )
    try:
        result = await db.execute(text(body.sql))
        cols = list(result.keys())
        rows = [
            {c: _jsonable(v) for c, v in zip(cols, row)}
            for row in result.fetchmany(MAX_QUERY_ROWS)
        ]
    except Exception as e:  # noqa: BLE001 — surface the DB error to the admin UI
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e))
    finally:
        # Never persist anything a read query might have triggered.
        await db.rollback()
    return QueryResult(rows=rows)


@router.get("/schema", response_model=list[IntrospectedTable])
async def app_database_schema(
    _admin: User = Depends(get_current_admin),
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
