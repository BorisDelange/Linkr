"""Web apps started from the IDE, and the reverse proxy that serves them.

The browser never reaches an app's port: it loads `…/apps/<id>/proxy/` from the
API, which forwards to 127.0.0.1:<port> (services/execution/web_apps.py). The
proxy routes carry no Linkr credentials — an iframe sends no Authorization
header — so the unguessable app id is the capability, and it dies with the app.
"""

import asyncio
import re
from urllib.parse import urlsplit

import httpx
import websockets
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, status
from fastapi.responses import RedirectResponse, Response, StreamingResponse
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask
from starlette.websockets import WebSocketDisconnect

from app.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.project import Project
from app.models.user import User
from app.schemas.base import CamelModel
from app.services import project_fs
from app.services.execution import environments, kernel, web_apps
from app.api.v1.routes.execution import _kernel_token, _require_code_execution

router = APIRouter(prefix="/apps", tags=["apps"])

# The path a gateway puts in front of Linkr (`/docker-8743`): plain segments only,
# since it is written into URLs and handed to the app's process.
_PREFIX = re.compile(r"^(/[A-Za-z0-9._~-]+)*$")


class StartAppRequest(CamelModel):
    project_uid: str
    # Relative to the project's scripts/ folder, as the IDE tree names it.
    path: str
    # A preset key; detected from the file when neither it nor `command` is given.
    framework: str | None = None
    # A shell command with $PORT, run in the file's folder. Skips the presets.
    command: str | None = Field(default=None, max_length=4000)
    # The path the browser reaches the API under, without `/api`: `""` at the
    # root, `/docker-8743` behind a gateway. Only the browser knows it.
    public_prefix: str = ""


def _require_enabled() -> None:
    if not (settings.enable_code_execution and settings.enable_web_apps):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Web apps are disabled on this instance")


def _own(app_id: str, user: User) -> web_apps.WebApp:
    app = web_apps.manager.get(app_id)
    if app is None or app.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "App not found")
    return app


@router.get("/presets")
async def list_presets(user: User = Depends(get_current_user)):
    """The frameworks Linkr knows how to launch, with the rules that recognise
    their entry files — the IDE applies them to the open file."""
    return [
        {"key": p.key, "label": p.label, "language": p.language, "names": list(p.names), "content": p.content}
        for p in web_apps.PRESETS
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
async def start_app(
    body: StartAppRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Start an app and return at once (`starting`); poll GET /apps/{id} until
    `ready`. The project environment is built first if it never was."""
    _require_enabled()
    await _require_code_execution(db, body.project_uid, user)
    prefix = body.public_prefix.rstrip("/")
    if not _PREFIX.match(prefix):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid public prefix")
    try:
        file = project_fs._safe_join(project_fs.scripts_dir(body.project_uid), body.path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    if not file.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")

    command = (body.command or "").strip() or None
    language = web_apps.language_of(body.path)
    preset_key = body.framework
    if not command:
        if preset_key is None:
            detected = web_apps.detect(body.path, file.read_text(encoding="utf-8", errors="replace"))
            if detected is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Not a web app Linkr recognises. Run it with a custom command instead.",
                )
            preset_key = detected.key
        p = web_apps.preset(preset_key)
        if p is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown framework: {preset_key}")
        language = p.language
    language = language or "python"

    environment = await environments.ensure_ready(db, body.project_uid, language, user.id)
    await kernel.manager._prepare_r_shared(language)
    spec = kernel.runtime_spec(language, body.project_uid, environment, _kernel_token(user, body.project_uid))
    try:
        app = await web_apps.manager.start(
            db,
            project_uid=body.project_uid, user_id=user.id, path=body.path, file=file,
            language=language, spec=spec, public_prefix=prefix, preset_key=preset_key, command=command,
        )
    except web_apps.AppLimitReached as e:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, str(e))
    except web_apps.AppStartError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    return app.public()


@router.get("")
async def list_apps(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if await db.get(Project, project_uid) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    return [a.public() for a in web_apps.manager.list_for_user(project_uid, user.id)]


@router.websocket("/ws-check")
async def ws_check(websocket: WebSocket):
    """Opens and closes: tells the IDE whether WebSockets get through the gateway
    in front of Linkr. Shiny and Streamlit cannot work without them."""
    await websocket.accept()
    await websocket.close()


@router.get("/{app_id}")
async def get_app(app_id: str, user: User = Depends(get_current_user)):
    """Polled by the app's open tab, which counts as a visit: an app on screen
    is not idle because nobody clicked in it for an hour."""
    app = _own(app_id, user)
    app.touch()
    return {**app.public(), "log": list(app.log)}


@router.delete("/{app_id}", status_code=status.HTTP_204_NO_CONTENT)
async def stop_app(app_id: str, user: User = Depends(get_current_user)):
    _own(app_id, user)
    web_apps.manager.stop(app_id)


# ── Proxy ────────────────────────────────────────────────────────────────────

# Hop-by-hop headers (RFC 9110 §7.6.1) belong to one connection, never forwarded.
_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
})
# Linkr's own credentials never reach an app: it runs code its author wrote, and
# may be opened by no one else, but a header is not its business either way.
_REQUEST_DROP = _HOP | {"host", "authorization", "x-forwarded-prefix", "x-forwarded-host", "x-forwarded-proto"}
_RESPONSE_DROP = _HOP | {"x-frame-options"}

_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # No read timeout: long-polling and server-sent events stay open.
        _client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=None), follow_redirects=False)
    return _client


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _upstream_path(scope: dict, app_id: str) -> str:
    """The request's path after `/proxy`, still percent-encoded, with its query."""
    raw = scope.get("raw_path") or scope["path"].encode()
    path = raw.decode("latin-1").split(f"/apps/{app_id}/proxy", 1)[1] or "/"
    query = scope.get("query_string", b"").decode("latin-1")
    return f"{path}?{query}" if query else path


def _forwarded(request_headers, scope: dict, app: web_apps.WebApp) -> list[tuple[str, str]]:
    host = request_headers.get("host", "")
    proto = request_headers.get("x-forwarded-proto") or scope.get("scheme", "http")
    headers = [(k, v) for k, v in request_headers.items() if k.lower() not in _REQUEST_DROP]
    upstream = f"127.0.0.1:{app.port}"
    # An app that checks Origin against Host (Tornado, Bokeh) sees itself; the
    # proxy has already checked the real origin (`_same_origin`).
    headers = [(k, f"http://{upstream}" if k.lower() == "origin" else v) for k, v in headers]
    headers += [
        ("host", upstream),
        ("x-forwarded-host", host),
        ("x-forwarded-proto", proto),
        ("x-forwarded-prefix", app.base_path.rstrip("/")),
    ]
    return headers


def _same_origin(headers, scope: dict) -> bool:
    """A browser request from Linkr's own page, or from no page at all. Compared by
    host name only: a gateway that forwards `Host $host` (nginx) drops the port
    the browser's Origin keeps."""
    origin = headers.get("origin")
    if origin is None:
        return True
    if origin in settings.cors_origin_list:
        return True
    host = urlsplit(origin).hostname
    if not host:
        return False
    seen = [headers.get("host", ""), *headers.get("x-forwarded-host", "").split(",")]
    return any(urlsplit(f"//{h.strip()}").hostname == host for h in seen if h.strip())


def _rewrite_location(value: str, app: web_apps.WebApp) -> str:
    parts = urlsplit(value)
    if parts.netloc and parts.hostname not in ("127.0.0.1", "localhost"):
        return value
    if parts.netloc or value.startswith("/"):
        path = parts.path if parts.netloc else value
        if path.startswith(app.base_path):
            return path
        rest = path.lstrip("/")
        if parts.netloc and parts.query:
            rest += f"?{parts.query}"
        return app.base_path + rest
    return value


def _rewrite_cookie(value: str, app: web_apps.WebApp) -> str:
    # A cookie the app scopes to `/` would otherwise go to every Linkr request.
    return re.sub(
        r"(?i)(;\s*path=)(/[^;]*)",
        lambda m: m.group(1) + app.base_path.rstrip("/") + (m.group(2) if m.group(2) != "/" else "/"),
        value,
    )


def _response_headers(upstream: httpx.Headers, app: web_apps.WebApp) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    has_csp = False
    for k, v in upstream.multi_items():
        name = k.lower()
        if name in _RESPONSE_DROP:
            continue
        if name == "location":
            v = _rewrite_location(v, app)
        elif name == "set-cookie":
            v = _rewrite_cookie(v, app)
        elif name == "content-security-policy":
            has_csp = True
        out.append((k, v))
    if not has_csp:
        # Framed by Linkr only: by its own origin, or the front's when it is served
        # apart from the API (development).
        ancestors = " ".join(["'self'", *settings.cors_origin_list])
        out.append(("content-security-policy", f"frame-ancestors {ancestors}"))
    out += [
        # A page that is cross-origin isolated (the dev server is) may embed only
        # documents that agree to it.
        ("cross-origin-embedder-policy", "credentialless"),
        ("cross-origin-resource-policy", "cross-origin"),
        # Streaming frameworks (server-sent events, long polling) must not wait in
        # an nginx buffer.
        ("x-accel-buffering", "no"),
    ]
    return out


@router.api_route(
    "/{app_id}/proxy",
    methods=["GET", "HEAD"],
    include_in_schema=False,
)
async def proxy_root(app_id: str):
    # Relative URLs in the app's page resolve against the folder, so it must end
    # in a slash. Relative Location: correct behind any gateway prefix.
    return RedirectResponse(f"{app_id}/proxy/", status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@router.api_route(
    "/{app_id}/proxy/{path:path}",
    methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    include_in_schema=False,
)
async def proxy_http(app_id: str, path: str, request: Request):
    app = web_apps.manager.running(app_id)
    if app is None:
        return Response("This app is not running.", status_code=status.HTTP_404_NOT_FOUND, media_type="text/plain")
    if request.method not in ("GET", "HEAD", "OPTIONS") and not _same_origin(request.headers, request.scope):
        return Response("Cross-origin request refused.", status_code=status.HTTP_403_FORBIDDEN, media_type="text/plain")
    app.touch()
    client = _http()
    # A body is streamed only when there is one: a streamed body goes out chunked,
    # and httpuv (Shiny for R) answers a chunked GET with 413.
    has_body = "content-length" in request.headers or "transfer-encoding" in request.headers
    upstream = client.build_request(
        request.method,
        f"http://127.0.0.1:{app.port}{_upstream_path(request.scope, app_id)}",
        headers=_forwarded(request.headers, request.scope, app),
        content=request.stream() if has_body else None,
    )
    try:
        resp = await client.send(upstream, stream=True)
    except httpx.HTTPError:
        message = "The app is still starting." if app.status == "starting" else "The app did not answer."
        return Response(message, status_code=status.HTTP_502_BAD_GATEWAY, media_type="text/plain")
    return _streamed(resp, app)


def _streamed(resp: httpx.Response, app: web_apps.WebApp) -> StreamingResponse:
    async def body():
        async for chunk in resp.aiter_raw():
            app.touch()
            yield chunk

    response = StreamingResponse(body(), status_code=resp.status_code, background=BackgroundTask(resp.aclose))
    # Set raw: Starlette's `headers=` dict would collapse repeated Set-Cookie.
    response.raw_headers = [
        (k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in _response_headers(resp.headers, app)
    ]
    return response


@router.websocket("/{app_id}/proxy/{path:path}")
async def proxy_ws(websocket: WebSocket, app_id: str, path: str):
    app = web_apps.manager.running(app_id)
    if app is None or not _same_origin(websocket.headers, websocket.scope):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    app.touch()
    protocols = [p.strip() for p in websocket.headers.get("sec-websocket-protocol", "").split(",") if p.strip()]
    skip = _REQUEST_DROP | {
        "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol",
    }
    headers = [(k, v) for k, v in _forwarded(websocket.headers, websocket.scope, app) if k.lower() not in skip]
    try:
        upstream = await websockets.connect(
            f"ws://127.0.0.1:{app.port}{_upstream_path(websocket.scope, app_id)}",
            additional_headers=headers,
            subprotocols=protocols or None,
            max_size=None,
            open_timeout=10,
            ping_interval=None,
        )
    except (OSError, websockets.InvalidHandshake, asyncio.TimeoutError):
        await websocket.close(code=1011)
        return
    await websocket.accept(subprotocol=upstream.subprotocol)

    async def to_app():
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            app.touch()
            if message.get("text") is not None:
                await upstream.send(message["text"])
            elif message.get("bytes") is not None:
                await upstream.send(message["bytes"])

    async def to_browser():
        async for message in upstream:
            app.touch()
            if isinstance(message, str):
                await websocket.send_text(message)
            else:
                await websocket.send_bytes(message)

    tasks = [asyncio.create_task(to_app()), asyncio.create_task(to_browser())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await upstream.close()
        try:
            await websocket.close()
        except (RuntimeError, WebSocketDisconnect):
            pass
