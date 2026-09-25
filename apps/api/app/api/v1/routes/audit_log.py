"""Reading the access log (core/audit). The whole log is `audit-log:read`;
anyone reads their own entries through /auth/my-activity."""

import asyncio

from fastapi import APIRouter, Depends, Query

from app.core import audit
from app.core.permissions import require_global_permission
from app.models.user import User
from app.schemas.audit import AuditEntry, AuditPage, AuditVerifyResult

router = APIRouter(prefix="/audit-log", tags=["audit-log"])


async def read_page(limit: int, offset: int, **filters) -> AuditPage:
    rows, total = await asyncio.to_thread(audit.query, limit, offset, **filters)
    return AuditPage(entries=[AuditEntry(**r) for r in rows], total=total)


@router.get("", response_model=AuditPage)
async def list_entries(
    user_id: int | None = Query(default=None, alias="userId"),
    data_source_id: str | None = Query(default=None, alias="dataSourceId"),
    action: str | None = None,
    since: str | None = None,
    until: str | None = None,
    q: str | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    _user: User = Depends(require_global_permission("audit-log:read")),
):
    return await read_page(
        limit, offset, user_id=user_id, data_source_id=data_source_id, action=action,
        since=since, until=until, text=q,
    )


@router.get("/verify", response_model=AuditVerifyResult)
async def verify_chain(_user: User = Depends(require_global_permission("audit-log:read"))):
    result = await asyncio.to_thread(audit.verify)
    return AuditVerifyResult(ok=result["ok"], checked=result["checked"], broken_at_seq=result["brokenAtSeq"])
