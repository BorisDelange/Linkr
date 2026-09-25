"""Access log: who did what, to which database, when, from where, and how it went.

Not a table: an append-only log is write-heavy, grows without bound and is read
rarely, which is what files are for. One JSON line per event goes to
``data_dir/audit/YYYY-MM-DD.jsonl`` and to stdout (a hospital's log collector
picks it up there); days before today are compacted into one zstd Parquet file
per month, and months older than the retention are deleted. DuckDB reads both.

**Written automatically.** `AuditMiddleware` opens a context for every HTTP
request and WebSocket; the auth dependencies name the actor (`set_actor`); the
few places that touch data add what they touched (`bind`). One line is written
when the request ends — only for requests that read data, change something, or
were refused, so UI polling does not flood it. Jobs, which outlive their request,
open their own context (`job_scope`).

**Never result data.** `detail` holds the SQL or code (truncated), which may
itself name a patient, so reading the log is `audit-log:read`, or one's own.

**Tamper evidence.** Each line carries `hash = sha256(previous hash + line)`, so
an edited or removed line breaks the chain from there on (`verify`). It does not
stop someone with the server's root from rewriting everything; the copy on stdout,
held by the collector, is what covers that. One writer per process: the chain
assumes a single API worker, which is how Linkr runs.
"""

import contextlib
import hashlib
import json
import os
import threading
import time
from collections.abc import Iterator
from contextvars import ContextVar
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb
import structlog

from app.config import settings

_DETAIL_MAX = 2000
_GENESIS = "0" * 64
_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
_REFUSED = {401, 403, 428}
_SKIP_ROUTES = ("/api/v1/health",)

# The on-disk schema. Fixed, so a day with no `row_count` still reads back as
# the same Parquet columns as a day with one.
COLUMNS: dict[str, str] = {
    "seq": "BIGINT",
    "at": "VARCHAR",
    "user_id": "BIGINT",
    "username": "VARCHAR",
    "via": "VARCHAR",
    "client": "VARCHAR",
    "method": "VARCHAR",
    "route": "VARCHAR",
    "status": "INTEGER",
    "duration_ms": "INTEGER",
    "client_ip": "VARCHAR",
    "action": "VARCHAR",
    "workspace_id": "VARCHAR",
    "project_uid": "VARCHAR",
    "data_source_id": "VARCHAR",
    "detail": "VARCHAR",
    "row_count": "BIGINT",
    "error": "VARCHAR",
    "hash": "VARCHAR",
}

_logger = structlog.get_logger("linkr.audit")
_current: ContextVar[dict | None] = ContextVar("linkr_audit", default=None)


# --- Context -----------------------------------------------------------------

def bind(**fields) -> None:
    """Add fields to the current request's (or job's) audit line. Outside a
    context — a test, a startup task — does nothing."""
    ctx = _current.get()
    if ctx is None:
        return
    for key, value in fields.items():
        if value is None:
            continue
        if key == "detail":
            value = str(value)[:_DETAIL_MAX]
        ctx[key] = value


def set_actor(user_id: int, username: str, via: str) -> None:
    bind(user_id=user_id, username=username, via=via)


def actor() -> dict:
    """The current actor, for a job launched from this request to carry."""
    ctx = _current.get() or {}
    return {k: ctx[k] for k in ("user_id", "username", "via", "client", "client_ip") if k in ctx}


@contextlib.contextmanager
def job_scope(job_id: str, kind: str, launched_by: dict) -> Iterator[dict]:
    """The audit context of a background job: one line when it ends, named
    after its launcher, whatever data it touched along the way."""
    ctx = {**launched_by, "via": f"job:{job_id}", "method": "JOB", "route": kind, "action": kind}
    token = _current.set(ctx)
    started = time.perf_counter()
    try:
        yield ctx
    except BaseException as exc:
        ctx.setdefault("error", str(exc)[:_DETAIL_MAX])
        ctx.setdefault("status", 499 if isinstance(exc, _cancelled()) else 500)
        raise
    finally:
        ctx.setdefault("status", 200)
        ctx["duration_ms"] = int((time.perf_counter() - started) * 1000)
        _current.reset(token)
        write(ctx)


def _cancelled():
    import asyncio

    return asyncio.CancelledError


class AuditMiddleware:
    """Pure ASGI (not BaseHTTPMiddleware) so WebSockets get a context too."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or scope.get("path", "").startswith(_SKIP_ROUTES):
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        ctx: dict = {
            "method": scope.get("method", "WS"),
            "route": scope.get("path"),
            "client_ip": (scope.get("client") or (None,))[0],
        }
        if client := headers.get(b"x-linkr-client"):
            ctx["client"] = client.decode("latin-1")[:40]
        token = _current.set(ctx)
        started = time.perf_counter()

        async def capture(message):
            if message["type"] == "http.response.start":
                ctx["status"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, capture)
        except Exception:
            ctx["status"] = 500
            raise
        finally:
            ctx["duration_ms"] = int((time.perf_counter() - started) * 1000)
            _current.reset(token)
            if _worth_logging(ctx):
                write(ctx)


def _worth_logging(ctx: dict) -> bool:
    if ctx.get("action"):
        return True
    if ctx.get("status") in _REFUSED:
        return True
    return ctx.get("method") in _MUTATING and ctx.get("user_id") is not None


# --- Storage -------------------------------------------------------------------

def _dir() -> Path:
    d = settings.data_path / "audit"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _line_hash(prev: str, body: str) -> str:
    return hashlib.sha256((prev + body).encode("utf-8")).hexdigest()


def _canonical(record: dict) -> str:
    return json.dumps({k: record.get(k) for k in COLUMNS if k != "hash"}, sort_keys=True, default=str)


class _Writer:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.state: tuple[int, str] | None = None
        self.root: Path | None = None

    def _recover(self, root: Path) -> tuple[int, str]:
        """The last (seq, hash) written, from today's-or-latest JSONL, else the
        latest Parquet month."""
        for path in sorted(root.glob("*.jsonl"), reverse=True):
            last = _last_line(path)
            if last:
                row = json.loads(last)
                return int(row["seq"]), str(row["hash"])
        months = sorted(root.glob("*.parquet"))
        if months:
            con = duckdb.connect()
            try:
                row = con.execute(
                    "SELECT seq, hash FROM read_parquet(?) ORDER BY seq DESC LIMIT 1", [str(months[-1])]
                ).fetchone()
            finally:
                con.close()
            if row:
                return int(row[0]), str(row[1])
        return 0, _GENESIS

    def write(self, ctx: dict) -> dict:
        root = _dir()
        with self.lock:
            if self.state is None or self.root != root:
                self.state, self.root = self._recover(root), root
            seq, prev = self.state
            now = datetime.now(timezone.utc)
            record = {k: ctx.get(k) for k in COLUMNS}
            record["seq"] = seq + 1
            record["at"] = now.isoformat(timespec="milliseconds")
            record["hash"] = _line_hash(prev, _canonical(record))
            line = json.dumps(record, default=str) + "\n"
            path = root / f"{now.date().isoformat()}.jsonl"
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(fd, line.encode("utf-8"))
            finally:
                os.close(fd)
            self.state = (record["seq"], record["hash"])
        return record


def _last_line(path: Path) -> str | None:
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        chunk = min(size, 64 * 1024)
        fh.seek(size - chunk)
        lines = [ln for ln in fh.read().splitlines() if ln.strip()]
    return lines[-1].decode("utf-8") if lines else None


_writer = _Writer()


def write(ctx: dict) -> None:
    """Append one line. A failure to log never fails the request it logs."""
    try:
        record = _writer.write(ctx)
    except Exception:  # noqa: BLE001 — the log must not take the app down
        _logger.exception("audit_write_failed")
        return
    _logger.info("audit", **{k: v for k, v in record.items() if v is not None})


def reset() -> None:
    """Forget the chain position (tests, or after the data dir changed)."""
    with _writer.lock:
        _writer.state = None
        _writer.root = None


# --- Compaction and retention ------------------------------------------------------

def _json_reader(paths: list[Path]) -> str:
    cols = "{" + ", ".join(f"'{k}': '{v}'" for k, v in COLUMNS.items()) + "}"
    files = ", ".join(f"'{p.as_posix()}'" for p in paths)
    return f"read_json([{files}], format = 'newline_delimited', columns = {cols})"


def compact(today: date | None = None) -> None:
    """Fold every JSONL day before `today` into its month's Parquet, then drop
    months past the retention. Atomic per month: the old Parquet stays readable
    until the new one replaces it."""
    today = today or datetime.now(timezone.utc).date()
    root = _dir()
    by_month: dict[str, list[Path]] = {}
    for path in root.glob("*.jsonl"):
        day = path.stem
        if day < today.isoformat():
            by_month.setdefault(day[:7], []).append(path)
    for month, days in sorted(by_month.items()):
        target = root / f"{month}.parquet"
        tmp = root / f".{month}.parquet.tmp"
        parts = [f"SELECT * FROM {_json_reader(sorted(days))}"]
        if target.exists():
            parts.insert(0, f"SELECT * FROM read_parquet('{target.as_posix()}')")
        con = duckdb.connect()
        try:
            con.execute(
                f"COPY ({' UNION ALL BY NAME '.join(parts)} ORDER BY seq) "
                f"TO '{tmp.as_posix()}' (FORMAT parquet, COMPRESSION zstd)"
            )
        finally:
            con.close()
        os.replace(tmp, target)
        for path in days:
            path.unlink(missing_ok=True)
    _apply_retention(root, today)


def _apply_retention(root: Path, today: date) -> None:
    cutoff = today - timedelta(days=settings.audit_retention_days)
    for path in root.glob("*.parquet"):
        try:
            year, month = (int(x) for x in path.stem.split("-"))
        except ValueError:
            continue
        month_end = (date(year + month // 12, month % 12 + 1, 1)) - timedelta(days=1)
        if month_end < cutoff:
            path.unlink(missing_ok=True)


async def run_periodic() -> None:
    """Compact at startup, then every 6 hours, until cancelled."""
    import asyncio

    while True:
        try:
            await asyncio.to_thread(compact)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — the next pass retries
            _logger.exception("audit_compact_failed")
        await asyncio.sleep(6 * 3600)


# --- Reading -----------------------------------------------------------------------

def _source_sql(root: Path) -> str | None:
    parts = []
    months = sorted(root.glob("*.parquet"))
    if months:
        files = ", ".join(f"'{p.as_posix()}'" for p in months)
        parts.append(f"SELECT * FROM read_parquet([{files}], union_by_name = true)")
    days = sorted(root.glob("*.jsonl"))
    if days:
        parts.append(f"SELECT * FROM {_json_reader(days)}")
    return " UNION ALL BY NAME ".join(parts) if parts else None


_FILTERS = {
    "user_id": "user_id = ?",
    "data_source_id": "data_source_id = ?",
    "action": "action = ?",
    "since": "at >= ?",
    "until": "at < ?",
}


def query(limit: int = 100, offset: int = 0, **filters) -> tuple[list[dict], int]:
    """Entries newest first, and the total matching count."""
    source = _source_sql(_dir())
    if source is None:
        return [], 0
    where, params = [], []
    for key, clause in _FILTERS.items():
        if filters.get(key) is not None:
            where.append(clause)
            params.append(filters[key])
    if filters.get("text"):
        where.append("(detail ILIKE ? OR route ILIKE ? OR username ILIKE ?)")
        params += [f"%{filters['text']}%"] * 3
    cond = f"WHERE {' AND '.join(where)}" if where else ""
    con = duckdb.connect()
    try:
        total = con.execute(f"SELECT count(*) FROM ({source}) {cond}", params).fetchone()[0]
        cur = con.execute(
            f"SELECT * FROM ({source}) {cond} ORDER BY seq DESC LIMIT ? OFFSET ?",
            [*params, int(limit), int(offset)],
        )
        names = [d[0] for d in cur.description]
        rows = [dict(zip(names, r)) for r in cur.fetchall()]
    finally:
        con.close()
    return rows, int(total)


def verify() -> dict:
    """Replay the hash chain over every kept line. A gap at the start is
    expected once retention dropped old months; a break anywhere after is not."""
    source = _source_sql(_dir())
    if source is None:
        return {"ok": True, "checked": 0, "brokenAtSeq": None}
    con = duckdb.connect()
    try:
        cur = con.execute(f"SELECT * FROM ({source}) ORDER BY seq")
        names = [d[0] for d in cur.description]
        prev: str | None = None
        checked = 0
        while batch := cur.fetchmany(5000):
            for values in batch:
                record = dict(zip(names, values))
                if prev is None:
                    prev = record["hash"]
                    checked += 1
                    continue
                if _line_hash(prev, _canonical(record)) != record["hash"]:
                    return {"ok": False, "checked": checked, "brokenAtSeq": record["seq"]}
                prev = record["hash"]
                checked += 1
    finally:
        con.close()
    return {"ok": True, "checked": checked, "brokenAtSeq": None}
