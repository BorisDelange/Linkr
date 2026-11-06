"""A credential and every channel it opened end together: API tokens with the
password, long-lived sockets and web-app sessions with the account, the password,
the project permission and the login session. API responses stay out of the
browser's HTTP cache."""

import asyncio
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1.routes import apps as apps_route
from app.api.v1.routes import execution as execution_route
from app.api.v1.routes import notifications as notifications_route
from app.core.ws_auth import WS_AUTH_FAILED, WS_FORBIDDEN, watch_credentials
from app.models.user import User
from app.services import database_credential_service, notification_hub, project_fs
from app.services.execution import web_apps

API = "/api/v1"
PASSWORD = "pw-for-tests-only"


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": PASSWORD})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": PASSWORD})
    return _bearer(r.json()["access_token"])


async def _bob(client, admin: dict) -> tuple[int, str]:
    r = await client.post(f"{API}/users", headers=admin, json={"username": "bob", "password": "bob-password-1"})
    login = await client.post(f"{API}/auth/login", json={"username": "bob", "password": "bob-password-1"})
    return r.json()["id"], login.json()["access_token"]


async def _mint(client, session: dict) -> str:
    r = await client.post(f"{API}/auth/api-tokens", headers=session, json={"name": "mcp"})
    assert r.status_code == 201, r.text
    return r.json()["token"]


async def _status(client, token: str) -> int:
    return (await client.get(f"{API}/auth/me", headers=_bearer(token))).status_code


# ── API tokens (a password change is credential recovery) ────────────────────


async def test_changing_ones_password_ends_ones_api_tokens(client):
    session = await _admin(client)
    key = await _mint(client, session)
    assert await _status(client, key) == 200

    r = await client.post(f"{API}/auth/change-password", headers=session,
                          json={"currentPassword": PASSWORD, "newPassword": "a-long-enough-one"})
    assert r.status_code == 200
    assert await _status(client, key) == 401

    fresh = _bearer(r.json()["access_token"])
    listed = (await client.get(f"{API}/auth/api-tokens", headers=fresh)).json()
    assert listed[0]["revokedAt"] is not None
    assert await _status(client, await _mint(client, fresh)) == 200


async def test_an_admin_password_reset_ends_the_accounts_api_tokens(client):
    admin = await _admin(client)
    bob_id, bob_session = await _bob(client, admin)
    key = await _mint(client, _bearer(bob_session))
    own_key = await _mint(client, admin)

    r = await client.patch(f"{API}/users/{bob_id}", headers=admin, json={"password": "bob-second-password"})
    assert r.status_code == 200
    assert await _status(client, key) == 401
    assert await _status(client, own_key) == 200


async def test_an_account_edit_without_a_password_keeps_the_tokens(client):
    admin = await _admin(client)
    bob_id, bob_session = await _bob(client, admin)
    key = await _mint(client, _bearer(bob_session))
    assert (await client.patch(f"{API}/users/{bob_id}", headers=admin, json={"email": "b@example.org"})).status_code == 200
    assert await _status(client, key) == 200


async def test_an_api_token_older_than_the_password_is_refused(client, db):
    admin = await _admin(client)
    bob_id, bob_session = await _bob(client, admin)
    key = await _mint(client, _bearer(bob_session))
    bob = await db.scalar(select(User).where(User.id == bob_id))
    bob.password_changed_at = datetime.now(timezone.utc) + timedelta(seconds=1)
    await db.commit()
    assert await _status(client, key) == 401


async def test_a_password_change_forgets_session_only_logins(client, monkeypatch):
    admin = await _admin(client)
    bob_id, _ = await _bob(client, admin)
    forgotten = []
    monkeypatch.setattr(database_credential_service, "forget_session_logins", forgotten.append)
    await client.patch(f"{API}/users/{bob_id}", headers=admin, json={"password": "bob-second-password"})
    await client.patch(f"{API}/users/{bob_id}", headers=admin, json={"isActive": False})
    assert forgotten == [bob_id, bob_id]


# ── Notifications socket ─────────────────────────────────────────────────────


class _Socket:
    def __init__(self, token: str):
        self.query_params = {"token": token}
        self.headers = {}
        self.accepted = asyncio.Event()
        self.closed_code: int | None = None
        self.sent: list[dict] = []

    async def accept(self) -> None:
        self.accepted.set()

    async def close(self, code: int) -> None:
        self.closed_code = code

    async def receive_text(self) -> str:
        await asyncio.Event().wait()
        return ""

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


async def _open_notifications(token: str, monkeypatch, interval: float = 0.01) -> tuple[_Socket, asyncio.Task]:
    monkeypatch.setattr(notifications_route, "AUTH_RECHECK_SECONDS", interval)
    socket = _Socket(token)
    task = asyncio.create_task(notifications_route.notifications_ws(socket))
    await asyncio.wait_for(socket.accepted.wait(), 2)
    return socket, task


async def test_the_notification_socket_stays_open_while_its_session_lives(client, monkeypatch):
    admin = await _admin(client)
    bob_id, bob_session = await _bob(client, admin)
    # Cancelled below between two checks: never in the middle of a database read.
    socket, task = await _open_notifications(bob_session, monkeypatch, interval=0.1)
    await asyncio.sleep(0.15)
    assert not task.done()
    notification_hub.publish(bob_id, {"type": "change"})
    await asyncio.sleep(0.01)
    assert socket.sent == [{"type": "change"}]
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_the_notification_socket_ends_with_the_account(client, monkeypatch):
    admin = await _admin(client)
    bob_id, bob_session = await _bob(client, admin)
    socket, task = await _open_notifications(bob_session, monkeypatch)
    await client.patch(f"{API}/users/{bob_id}", headers=admin, json={"isActive": False})
    await asyncio.wait_for(task, 2)
    assert socket.closed_code == WS_AUTH_FAILED


async def test_the_notification_socket_ends_with_the_password(client, monkeypatch):
    admin = await _admin(client)
    bob_id, bob_session = await _bob(client, admin)
    socket, task = await _open_notifications(bob_session, monkeypatch)
    await client.patch(f"{API}/users/{bob_id}", headers=admin, json={"password": "bob-second-password"})
    await asyncio.wait_for(task, 2)
    assert socket.closed_code == WS_AUTH_FAILED


# ── Terminal ─────────────────────────────────────────────────────────────────


async def test_the_watch_says_why_a_socket_must_end(client):
    token = (await _admin(client))["Authorization"].removeprefix("Bearer ")

    async def refused(_user) -> bool:
        return False

    assert await asyncio.wait_for(watch_credentials(_Socket(token), 0.01, refused), 2) == WS_FORBIDDEN
    assert await asyncio.wait_for(watch_credentials(_Socket("not-a-jwt"), 0.01), 2) == WS_AUTH_FAILED


async def test_a_terminal_ends_when_code_execution_is_withdrawn(client, monkeypatch):
    token = (await _admin(client))["Authorization"].removeprefix("Bearer ")
    allowed = {"now": True}

    async def require(_db, _project, _user) -> None:
        if not allowed["now"]:
            raise HTTPException(403)

    async def shell(*_args, **_kwargs) -> None:
        await asyncio.Event().wait()

    monkeypatch.setattr(execution_route, "_require_code_execution", require)
    monkeypatch.setattr(execution_route, "_terminal_pty_loop", shell)
    monkeypatch.setattr(execution_route, "TERMINAL_AUTH_RECHECK_SECONDS", 0.01)
    socket = _Socket(token)
    socket.query_params.update(projectUid="p", language="bash")
    socket.cookies = {}
    task = asyncio.create_task(execution_route.terminal_ws(socket))
    await asyncio.wait_for(socket.accepted.wait(), 2)
    await asyncio.sleep(0.05)
    assert not task.done()
    allowed["now"] = False
    await asyncio.wait_for(task, 2)
    assert socket.closed_code == WS_FORBIDDEN


# ── Web-app sessions ─────────────────────────────────────────────────────────


def _app(project_uid: str, user_id: int, app_id: str = "abc") -> web_apps.WebApp:
    return web_apps.WebApp(
        app_id=app_id, project_uid=project_uid, user_id=user_id, label="app.py", path="app.py",
        framework="custom", command="", port=1, base_path=f"/api/v1/apps/{app_id}/proxy/",
        job_id="j", proc=None, status="ready",
    )


def _cookies(app: web_apps.WebApp) -> dict:
    token = apps_route.session_token(app.app_id, app.user_id, int(time.time()) + 60)
    return {apps_route._session_cookie(app.app_id): token}


async def _project(client, headers) -> str:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    r = await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})
    return r.json()["uid"]


async def test_a_session_serves_while_its_owner_may_run_code(client):
    admin = await _admin(client)
    me = (await client.get(f"{API}/auth/me", headers=admin)).json()["id"]
    app = _app(await _project(client, admin), me)
    assert await apps_route._session_open(_cookies(app), app)
    assert not await apps_route._session_open({}, app)


async def test_a_session_ends_when_the_owner_loses_code_execution(client):
    admin = await _admin(client)
    bob_id, _ = await _bob(client, admin)
    app = _app(await _project(client, admin), bob_id)
    assert not await apps_route._session_open(_cookies(app), app)


async def test_a_session_ends_with_the_owners_account(client, monkeypatch):
    admin = await _admin(client)
    bob_id, _ = await _bob(client, admin)

    async def allowed(_db, _project, _user) -> None:
        return None

    monkeypatch.setattr(apps_route, "_require_code_execution", allowed)
    app = _app("p", bob_id)
    cookies = _cookies(app)
    assert await apps_route._session_open(cookies, app)
    await client.patch(f"{API}/users/{bob_id}", headers=admin, json={"isActive": False})
    assert not await apps_route._session_open(cookies, app)


async def test_a_deleted_owner_ends_the_session(client):
    admin = await _admin(client)
    bob_id, _ = await _bob(client, admin)
    app = _app("p", bob_id)
    cookies = _cookies(app)
    await client.delete(f"{API}/users/{bob_id}", headers=admin)
    assert not await apps_route._session_open(cookies, app)


async def test_a_session_older_than_the_password_ends(client, monkeypatch):
    admin = await _admin(client)
    bob_id, _ = await _bob(client, admin)

    async def allowed(_db, _project, _user) -> None:
        return None

    monkeypatch.setattr(apps_route, "_require_code_execution", allowed)
    app = _app("p", bob_id)
    before = _cookies(app)
    await client.patch(f"{API}/users/{bob_id}", headers=admin, json={"password": "bob-second-password"})
    assert not await apps_route._session_open(before, app)
    assert await apps_route._session_open(_cookies(app), app)


async def test_the_proxy_refuses_a_session_whose_owner_is_gone(client, monkeypatch):
    admin = await _admin(client)
    bob_id, _ = await _bob(client, admin)
    app = _app("p", bob_id)
    monkeypatch.setitem(web_apps.manager._apps, app.app_id, app)
    cookies = _cookies(app)
    await client.patch(f"{API}/users/{bob_id}", headers=admin, json={"isActive": False})
    client.cookies.clear()
    name = apps_route._session_cookie("abc")
    r = await client.get(f"{API}/apps/abc/proxy/x", headers={"cookie": f"{name}={cookies[name]}"})
    assert r.status_code == 404


async def test_logout_ends_the_web_app_sessions_of_that_user(client, monkeypatch):
    admin = await _admin(client)
    me = (await client.get(f"{API}/auth/me", headers=admin)).json()["id"]
    bob_id, _ = await _bob(client, admin)
    project = await _project(client, admin)
    mine, theirs = _app(project, me, "mine"), _app(project, bob_id, "theirs")
    monkeypatch.setitem(web_apps.manager._apps, "mine", mine)
    monkeypatch.setitem(web_apps.manager._apps, "theirs", theirs)

    opened = await client.post(f"{API}/apps/mine/session", headers=admin)
    name = apps_route._session_cookie("mine")
    held = {name: opened.cookies[name]}
    their_cookies = _cookies(theirs)
    client.cookies.clear()
    assert await apps_route._session_open(held, mine)

    r = await client.post(f"{API}/auth/logout", headers=admin)
    assert r.status_code == 200
    expired = [c for c in r.headers.get_list("set-cookie") if c.startswith(f"{name}=")]
    assert len(expired) == 1 and "Max-Age=0" in expired[0] and f"Path={mine.base_path}" in expired[0]
    assert not any(c.startswith(apps_route._session_cookie("theirs")) for c in r.headers.get_list("set-cookie"))

    assert not apps_route._session_valid(held, mine)
    assert apps_route._session_valid(their_cookies, theirs)

    client.cookies.clear()
    renewed = await client.post(f"{API}/apps/mine/session", headers=admin)
    assert apps_route._session_valid({name: renewed.cookies[name]}, mine)
    client.cookies.clear()


async def _running(app_id: str, project: str, user_id: int, monkeypatch) -> web_apps.WebApp:
    app = _app(project, user_id, app_id)
    app.task = asyncio.create_task(asyncio.Event().wait())
    monkeypatch.setitem(web_apps.manager._apps, app_id, app)
    return app


async def test_disabling_or_deleting_an_account_stops_its_web_apps(client, monkeypatch):
    admin = await _admin(client)
    bob_id, _ = await _bob(client, admin)
    app = await _running("one", "p", bob_id, monkeypatch)
    await client.patch(f"{API}/users/{bob_id}", headers=admin, json={"role": "user"})
    assert not app.task.cancelling() and app.status == "ready"

    await client.patch(f"{API}/users/{bob_id}", headers=admin, json={"isActive": False})
    assert app.status == "stopped"

    await client.patch(f"{API}/users/{bob_id}", headers=admin, json={"isActive": True})
    again = await _running("two", "p", bob_id, monkeypatch)
    await client.delete(f"{API}/users/{bob_id}", headers=admin)
    assert again.status == "stopped"


class _ProxiedSocket:
    def __init__(self, cookies: dict):
        self.cookies = cookies
        self.headers = {}
        self.scope = {"path": "/api/v1/apps/abc/proxy/ws", "scheme": "ws"}
        self.closed_code: int | None = None

    async def accept(self, subprotocol=None) -> None:
        pass

    async def receive(self) -> dict:
        await asyncio.Event().wait()
        return {}

    async def close(self, code: int = 1000) -> None:
        self.closed_code = code


class _Upstream:
    subprotocol = None

    def __aiter__(self):
        return self

    async def __anext__(self):
        await asyncio.Event().wait()

    async def close(self) -> None:
        pass


async def test_an_open_app_socket_ends_with_its_session(monkeypatch):
    app = _app("p", 1)
    monkeypatch.setitem(web_apps.manager._apps, app.app_id, app)
    still = {"open": True}

    async def session_open(_cookies, _app) -> bool:
        return still["open"]

    async def connect(*_args, **_kwargs):
        return _Upstream()

    monkeypatch.setattr(apps_route, "_session_open", session_open)
    monkeypatch.setattr(apps_route.websockets, "connect", connect)
    monkeypatch.setattr(apps_route, "SESSION_RECHECK_SECONDS", 0.01)
    socket = _ProxiedSocket({})
    task = asyncio.create_task(apps_route.proxy_ws(socket, app.app_id, "ws"))
    await asyncio.sleep(0.05)
    assert not task.done()
    still["open"] = False
    await asyncio.wait_for(task, 2)
    assert socket.closed_code == 1008


class _StreamedUpstream:
    status_code = 200
    headers = httpx.Headers({})

    async def aiter_raw(self):
        for chunk in (b"one", b"two", b"three"):
            yield chunk

    async def aclose(self) -> None:
        pass


async def test_a_streamed_app_response_stops_with_its_session(monkeypatch):
    app = _app("p", 1)
    verdicts = iter([True, False])

    async def session_open(_cookies, _app) -> bool:
        return next(verdicts)

    monkeypatch.setattr(apps_route, "_session_open", session_open)
    monkeypatch.setattr(apps_route, "SESSION_RECHECK_SECONDS", 0)
    response = apps_route._streamed(_StreamedUpstream(), app, {})
    assert [chunk async for chunk in response.body_iterator] == [b"one"]


# ── HTTP cache ───────────────────────────────────────────────────────────────


async def test_file_and_json_responses_are_never_stored_by_the_browser(client):
    admin = await _admin(client)
    project = await _project(client, admin)
    (project_fs.scripts_dir(project) / "out.csv").write_text("a\n1\n")
    r = await client.get(f"{API}/ide-files/raw", headers=admin, params={"projectUid": project, "path": "out.csv"})
    assert r.status_code == 200 and r.text == "a\n1\n"
    assert r.headers["cache-control"] == "no-store"
    assert (await client.get(f"{API}/projects", headers=admin)).headers["cache-control"] == "no-store"
    assert (await client.get(f"{API}/nonexistent", headers=admin)).headers["cache-control"] == "no-store"


async def test_the_web_app_proxy_keeps_the_apps_own_cache_policy(client):
    app = _app("p", 1)
    kept = dict(apps_route._response_headers(httpx.Headers({"cache-control": "max-age=60"}), app))
    assert kept["cache-control"] == "max-age=60"
    r = await client.get(f"{API}/apps/none/proxy/x")
    assert r.status_code == 404 and "no-store" not in r.headers.get("cache-control", "")


def test_an_app_response_without_a_policy_is_revalidated_through_the_session():
    assert dict(apps_route._response_headers(httpx.Headers({}), _app("p", 1)))["cache-control"] == "private, no-cache"
