"""Reading the access log (core/audit). The whole log is `audit-log:read`;
anyone reads their own entries through /auth/my-activity.

The list is paged, sorted and filtered server-side — a log reaches millions of
lines, so the client only ever holds one page. `filters` is a JSON object of
column → text (contains) or list (any of); unknown columns are ignored."""

import asyncio
import json
import tempfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse

from app.core import audit
from app.core.permissions import require_global_permission
from app.models.user import User
from app.schemas.audit import AuditEntry, AuditPage, AuditVerifyResult

router = APIRouter(prefix="/audit-log", tags=["audit-log"])

# The list filters the log view offers, whose values come from the whole log.
SELECT_COLUMNS = ["username", "via_kind", "what", "data_source_id", "status"]


def parse_filters(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "filters must be a JSON object") from exc
    if not isinstance(value, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "filters must be a JSON object")
    return value


async def read_page(
    limit: int, offset: int, sort: str | None = None, desc: bool = True, filters: dict | None = None, **exact,
) -> AuditPage:
    rows, total = await asyncio.to_thread(audit.query, limit, offset, sort, desc, filters, **exact)
    options = await asyncio.to_thread(audit.distinct_values, SELECT_COLUMNS, **exact)
    return AuditPage(entries=[AuditEntry(**r) for r in rows], total=total, filter_options=options)


@router.get("", response_model=AuditPage)
async def list_entries(
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    sort: str | None = None,
    desc: bool = True,
    filters: str | None = None,
    _user: User = Depends(require_global_permission("audit-log:read")),
):
    return await read_page(limit, offset, sort, desc, parse_filters(filters))


@router.get("/export")
async def export_entries(
    background: BackgroundTasks,
    sort: str | None = None,
    desc: bool = True,
    filters: str | None = None,
    _user: User = Depends(require_global_permission("audit-log:read")),
):
    """Every entry matching the filters, as CSV — not just the page on screen."""
    tmp = Path(tempfile.mkstemp(suffix=".csv")[1])
    await asyncio.to_thread(audit.export_csv, tmp, sort, desc, parse_filters(filters))
    background.add_task(tmp.unlink, missing_ok=True)
    return FileResponse(tmp, media_type="text/csv", filename="linkr-access-log.csv")


@router.get("/verify", response_model=AuditVerifyResult)
async def verify_chain(_user: User = Depends(require_global_permission("audit-log:read"))):
    result = await asyncio.to_thread(audit.verify)
    return AuditVerifyResult(ok=result["ok"], checked=result["checked"], broken_at_seq=result["brokenAtSeq"])
