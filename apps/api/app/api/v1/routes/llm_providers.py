from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.crypto import encrypt
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.bench_report import BenchReport
from app.models.llm_provider import LlmProvider
from app.models.user import User
from app.schemas.llm_provider import (
    BenchReportCreate,
    BenchReportResponse,
    LlmProviderCreate,
    LlmProviderResponse,
    LlmProviderUpdate,
)
from app.services.llm.endpoint_locality import is_blocked_endpoint, is_local_endpoint

router = APIRouter(tags=["llm"])

_PROVIDERS = "/llm-providers"
_REPORTS = "/llm-bench-reports"


def _to_response(provider: LlmProvider) -> dict:
    """Serialise a provider WITHOUT its API key — the key is decrypted only when
    the server itself calls the model."""
    return {
        "id": provider.id,
        "workspaceId": provider.workspace_id,
        "name": provider.name or {},
        "kind": provider.kind,
        "baseUrl": provider.base_url,
        "model": provider.model,
        "hasApiKey": bool(provider.api_key_encrypted),
        "isLocal": provider.is_local,
        "enabled": provider.enabled,
        "surfaces": provider.surfaces or [],
        "acknowledgedById": provider.acknowledged_by_id,
        "acknowledgedAt": provider.acknowledged_at,
        "createdById": provider.created_by_id,
        "createdAt": provider.created_at,
        "updatedAt": provider.updated_at,
    }


def _guard_remote(base_url: str, acknowledgement: str | None) -> bool:
    """Validate a remote endpoint, returning whether it is local.

    Two independent gates, because they protect against different things: the
    instance switch is an administrator forbidding data egress outright, while
    the acknowledgement is the person taking responsibility for it. A missing
    acknowledgement must fail closed — silently accepting one would let clinical
    context reach a third party by omission.
    """
    scheme = base_url.split("://", 1)[0].lower() if "://" in base_url else ""
    if scheme and scheme not in ("http", "https"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Only http(s) endpoints are supported."
        )
    if is_blocked_endpoint(base_url):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This endpoint (metadata / link-local / reserved address) is not allowed.",
        )
    local = is_local_endpoint(base_url)
    if local:
        return True
    if not settings.allow_remote_llm:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Remote LLM endpoints are disabled on this instance "
            "(LINKR_ALLOW_REMOTE_LLM).",
        )
    if not (acknowledgement or "").strip():
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "A remote endpoint requires an explicit acknowledgement.",
        )
    return False


async def _load(db: AsyncSession, provider_id: str, user: User, permission: str) -> LlmProvider:
    provider = await db.get(LlmProvider, provider_id)
    if provider is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, provider.workspace_id, user, permission)
    return provider


@router.get(_PROVIDERS, response_model=list[LlmProviderResponse])
async def list_providers(
    workspace_id: str = Query(alias="workspaceId"),
    surface: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Providers for a workspace. `surface` filters to those approved for it and
    enabled — that is the list a project page offers its users."""
    await check_workspace_permission(db, workspace_id, user, "llm-config:read")
    rows = (
        await db.scalars(
            select(LlmProvider).where(LlmProvider.workspace_id == workspace_id)
        )
    ).all()
    if surface:
        rows = [r for r in rows if r.enabled and surface in (r.surfaces or [])]
    return [_to_response(row) for row in rows]


@router.post(_PROVIDERS, response_model=LlmProviderResponse, status_code=status.HTTP_201_CREATED)
async def create_provider(
    payload: LlmProviderCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, payload.workspace_id, user, "llm-config:write")
    local = _guard_remote(payload.base_url, payload.acknowledgement_text)

    provider = LlmProvider(
        workspace_id=payload.workspace_id,
        name=payload.name,
        kind=payload.kind,
        base_url=payload.base_url,
        model=payload.model,
        api_key_encrypted=encrypt(payload.api_key) if payload.api_key else None,
        is_local=local,
        enabled=payload.enabled,
        surfaces=payload.surfaces,
        created_by_id=user.id,
    )
    if not local:
        provider.acknowledged_by_id = user.id
        provider.acknowledged_at = datetime.now(timezone.utc)
        provider.acknowledgement_text = payload.acknowledgement_text
    db.add(provider)
    await db.commit()
    await db.refresh(provider)
    return _to_response(provider)


@router.patch(_PROVIDERS + "/{provider_id}", response_model=LlmProviderResponse)
async def update_provider(
    provider_id: str,
    payload: LlmProviderUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    provider = await _load(db, provider_id, user, "llm-config:write")
    data = payload.model_dump(exclude_unset=True)

    if "base_url" in data:
        new_url = data["base_url"]
        url_changed = new_url != provider.base_url
        # A changed remote URL needs a FRESH acknowledgement: the stored one was
        # given for the old endpoint, so carrying it over would let an admin
        # silently re-point an approved provider at a third party. Only an
        # unchanged URL may keep its existing acknowledgement.
        ack = data.get("acknowledgement_text")
        if not ack and not url_changed:
            ack = provider.acknowledgement_text
        local = _guard_remote(new_url, ack)
        provider.is_local = local
        if not local:
            provider.acknowledged_by_id = user.id
            provider.acknowledged_at = datetime.now(timezone.utc)
            provider.acknowledgement_text = ack

    if "api_key" in data:
        # "" clears the key; a value replaces it; absent leaves it untouched.
        provider.api_key_encrypted = encrypt(data["api_key"]) if data["api_key"] else None

    for field in ("name", "kind", "base_url", "model", "enabled", "surfaces"):
        if field in data:
            setattr(provider, field, data[field])
    # A bare acknowledgement edit (no URL change) just updates the stored text;
    # the URL-change branch above already owns the ack when base_url is present.
    if "acknowledgement_text" in data and "base_url" not in data:
        provider.acknowledgement_text = data["acknowledgement_text"]

    await db.commit()
    await db.refresh(provider)
    return _to_response(provider)


@router.delete(_PROVIDERS + "/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_provider(
    provider_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    provider = await _load(db, provider_id, user, "llm-config:write")
    await db.delete(provider)
    await db.commit()


# --- Bench reports ---------------------------------------------------------


@router.get(_REPORTS, response_model=list[BenchReportResponse])
async def list_reports(
    workspace_id: str = Query(alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "llm-config:read")
    rows = (
        await db.scalars(
            select(BenchReport)
            .where(BenchReport.workspace_id == workspace_id)
            .order_by(BenchReport.ran_at.desc())
        )
    ).all()
    return rows


@router.post(_REPORTS, response_model=BenchReportResponse, status_code=status.HTTP_201_CREATED)
async def create_report(
    payload: BenchReportCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, payload.workspace_id, user, "llm-config:write")
    # One report per (workspace, model): an older run on the same machine is of
    # no use once a newer one exists.
    existing = await db.scalars(
        select(BenchReport).where(
            BenchReport.workspace_id == payload.workspace_id,
            BenchReport.model == payload.model,
        )
    )
    for row in existing.all():
        await db.delete(row)

    report = BenchReport(
        **payload.model_dump(exclude={"cases"}),
        cases=[case.model_dump() for case in payload.cases],
        ran_by_id=user.id,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)
    return report


@router.delete(_REPORTS + "/{report_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_report(
    report_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    report = await db.get(BenchReport, report_id)
    if report is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, report.workspace_id, user, "llm-config:write")
    await db.delete(report)
    await db.commit()
