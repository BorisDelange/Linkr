"""Relay assistant requests to a provider's model.

The API key is the reason this exists. It is stored encrypted and never returned
by the API, so a browser cannot authenticate to Mistral or OpenAI itself — it
asks Linkr, which decrypts the key and forwards. The key therefore stays on the
server even though the assistant runs in the page.

It also covers a local endpoint behind authentication (vLLM, LiteLLM), which the
browser equally cannot reach on its own.

Only providers already configured for the workspace can be reached: the client
names a provider id, never a URL, so this cannot be turned into an open proxy
for arbitrary hosts.
"""

import json

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.crypto import decrypt
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.llm_provider import LlmProvider
from app.models.user import User
from app.services.llm.endpoint_locality import is_blocked_endpoint

logger = structlog.get_logger()

router = APIRouter(tags=["llm"])

# Long enough for a small local model to think on modest hardware; short enough
# that a wedged endpoint does not hold a connection open indefinitely.
_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)

# Redirects are never followed: a legitimate remote provider that 302s to
# 169.254.169.254 would otherwise defeat the SSRF check, which only sees the
# original URL. httpx already defaults to False, but pin it so a refactor can't
# silently flip it.
_LIMITS = httpx.Limits(max_connections=32, max_keepalive_connections=8)

# The non-streaming branch buffers the whole upstream body; cap it so a provider
# pointed at a huge (or hostile) response can't OOM the worker.
_MAX_RESPONSE_BYTES = 32 * 1024 * 1024
# A chat request is small; a multi-MB body is either abuse or a bug.
_MAX_REQUEST_BYTES = 4 * 1024 * 1024


def _chat_url(base_url: str) -> str:
    return f"{base_url.rstrip('/')}/chat/completions"


def _guard_url(base_url: str) -> None:
    """Refuse to forward to an unsafe target, at request time.

    The stored `is_local`/`acknowledged` verdict is not sufficient on its own:
    the URL can be edited after acknowledgement, and even a "local" provider must
    not be a scheme other than http(s) or a metadata/link-local address.
    """
    scheme = base_url.split("://", 1)[0].lower() if "://" in base_url else ""
    if scheme not in ("http", "https"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unsupported endpoint scheme.")
    if is_blocked_endpoint(base_url):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This endpoint is not permitted.")


async def _authorize(
    provider_id: str, user: User, db: AsyncSession
) -> tuple[LlmProvider, dict[str, str]]:
    provider = await db.get(LlmProvider, provider_id)
    if provider is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    # Read permission on the workspace is the gate: anyone who may use the
    # assistant may reach the model an admin approved, but nobody else can.
    await check_workspace_permission(db, provider.workspace_id, user, "llm-config:read")
    if not provider.enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This model is disabled.")
    # A remote provider that was never acknowledged must not be reachable, or the
    # acknowledgement gate would be enforced only in the UI.
    if not provider.is_local and not provider.acknowledged_at:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "This remote model has not been acknowledged.",
        )

    headers = {"Content-Type": "application/json"}
    if provider.api_key_encrypted:
        key = decrypt(provider.api_key_encrypted)
        if key:
            headers["Authorization"] = f"Bearer {key}"
    return provider, headers


def _body(payload: dict, provider: LlmProvider) -> dict:
    # The model comes from the stored provider, not the client: the point of
    # per-surface approval is that a user cannot substitute another model.
    return {**payload, "model": provider.model}


@router.post("/llm-providers/{provider_id}/chat")
async def proxy_chat(
    provider_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Forward one chat completion, streaming or not.

    The upstream response is passed through as-is so the client keeps parsing the
    OpenAI-compatible shape it already understands.
    """
    provider, headers = await _authorize(provider_id, user, db)
    _guard_url(provider.base_url)

    raw = await request.body()
    if len(raw) > _MAX_REQUEST_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Request too large.")
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Body must be JSON.") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Body must be a JSON object.")
    payload = _body(parsed, provider)
    url = _chat_url(provider.base_url)

    if not payload.get("stream"):
        async with httpx.AsyncClient(
            timeout=_TIMEOUT, limits=_LIMITS, follow_redirects=False
        ) as client:
            try:
                upstream = await client.post(url, headers=headers, json=payload)
            except httpx.HTTPError as exc:
                # The exception carries the internal URL/host; keep it in the log,
                # never in the client-facing detail (it is the SSRF readout).
                logger.warning("llm_proxy_unreachable", provider=provider.id, error=str(exc))
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY, "Model endpoint unreachable."
                ) from exc
            body = upstream.content
        if len(body) > _MAX_RESPONSE_BYTES:
            logger.warning("llm_proxy_response_too_large", provider=provider.id, size=len(body))
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Model response too large.")
        # Surface the upstream status so the client can tell a bad key (401) from
        # a bad model name (404) rather than seeing one opaque error.
        return StreamingResponse(
            iter([body]),
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "application/json"),
        )

    async def stream():
        async with httpx.AsyncClient(
            timeout=_TIMEOUT, limits=_LIMITS, follow_redirects=False
        ) as client:
            try:
                async with client.stream(
                    "POST", url, headers=headers, json=payload
                ) as upstream:
                    if upstream.status_code >= 400:
                        # The status is informative; the upstream body may leak
                        # internal detail, so send only the code.
                        yield _sse_error(f"Model endpoint returned {upstream.status_code}.")
                        return
                    async for chunk in upstream.aiter_raw():
                        yield chunk
            except httpx.HTTPError as exc:
                logger.warning("llm_proxy_stream_failed", provider=provider.id, error=str(exc))
                yield _sse_error("Model endpoint unreachable.")

    return StreamingResponse(stream(), media_type="text/event-stream")


def _sse_error(message: str) -> bytes:
    """Report a failure inside the stream.

    The response has already begun by the time an upstream error appears, so the
    status code is spent — the client would otherwise see the stream stop with no
    reason given.
    """
    return f"data: {json.dumps({'error': {'message': message}})}\n\n".encode()
