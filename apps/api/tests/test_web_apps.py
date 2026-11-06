"""Web apps started from the IDE (services/execution/web_apps.py) and the proxy
that serves them (routes/apps.py)."""

import asyncio
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from app.api.v1.routes import apps as apps_route
from app.models.job import Job
from app.services import project_fs
from app.services.execution import jobs, web_apps
from app.services.execution.kernel import R_LIB_SETUP, RuntimeSpec

API = "/api/v1"


def _app(**kw) -> web_apps.WebApp:
    fields = dict(
        app_id="abc", project_uid="p", user_id=1, label="app.py", path="app.py",
        framework="custom", command="", port=8701, base_path="/docker-1/api/v1/apps/abc/proxy/",
        job_id="j", proc=None,
    )
    return web_apps.WebApp(**{**fields, **kw})


def test_detect_by_name_then_content():
    assert web_apps.detect("dash/app.R", "").key == "shiny"
    assert web_apps.detect("plumber.R", "").key == "plumber"
    assert web_apps.detect("x.R", "ui <- fluidPage()\nshinyApp(ui, server)").key == "shiny"
    assert web_apps.detect("x.py", "import streamlit as st\nst.write(1)").key == "streamlit"
    assert web_apps.detect("x.py", "from shiny.express import input").key == "shiny-python"
    assert web_apps.detect("x.py", "from dash import Dash\napp = Dash(__name__)").key == "dash"
    assert web_apps.detect("x.py", "import gradio as gr").key == "gradio"
    assert web_apps.detect("x.py", "from gradio import Blocks").key == "gradio"
    assert web_apps.detect("x.py", "import panel as pn").key == "panel"
    assert web_apps.detect("x.py", "app = FastAPI()").key == "fastapi"
    assert web_apps.detect("x.py", "app = Flask(__name__)").key == "flask"
    assert web_apps.detect("api.R", "#* @get /echo\nfunction() 1").key == "plumber"
    # A comment or a longer name is not an import.
    assert web_apps.detect("x.py", "# import gradio") is None
    assert web_apps.detect("x.py", "import panelist") is None
    assert web_apps.detect("x.py", "import pandas as pd") is None
    # A Python file is never taken for an R app, whatever its name.
    assert web_apps.detect("app.py", "") is None


def test_preset_patterns_read_the_same_in_javascript():
    # The IDE applies them with `new RegExp(p, 'm')`: no Python-only syntax.
    for p in web_apps.PRESETS:
        if p.content:
            assert not re.search(r"\(\?P|\(\?[aiLmsux]|\\A|\\Z", p.content), p.key


def test_python_preset_argv_runs_the_project_interpreter(tmp_path):
    file = tmp_path / "my app.py"
    spec = RuntimeSpec("/venv/bin/python", str(tmp_path), {})
    argv = web_apps.launch_argv(web_apps.preset("streamlit"), spec, file, 8705, "/b/", tmp_path / "l")
    assert argv[:4] == ["/venv/bin/python", "-m", "streamlit", "run"]
    assert str(file) in argv and "8705" in argv and "127.0.0.1" in argv


@pytest.mark.parametrize("key,expected", [
    ("panel", ["-m", "panel", "serve", "{file}", "--address", "127.0.0.1", "--port", "8705"]),
    ("flask", ["-m", "flask", "--app", "{file}", "run", "--host", "127.0.0.1", "--port", "8705"]),
    ("fastapi", ["-m", "uvicorn", "my_app:app", "--host", "127.0.0.1", "--port", "8705", "--root-path", "/b/"]),
])
def test_python_presets_bind_loopback_on_the_given_port(tmp_path, key, expected):
    file = tmp_path / "my_app.py"
    spec = RuntimeSpec("/venv/bin/python", str(tmp_path), {})
    argv = web_apps.launch_argv(web_apps.preset(key), spec, file, 8705, "/b/", tmp_path / "l")
    wanted = [a.replace("{file}", str(file)) for a in expected]
    assert argv[0] == "/venv/bin/python" and argv[1:len(wanted) + 1] == wanted


def test_gradio_preset_runs_the_script_and_configures_it_by_environment(tmp_path):
    file = tmp_path / "x.py"
    gradio = web_apps.preset("gradio")
    spec = RuntimeSpec("/venv/bin/python", str(tmp_path), {})
    assert web_apps.launch_argv(gradio, spec, file, 8705, "/b/", tmp_path / "l") == ["/venv/bin/python", str(file)]
    assert gradio.env["GRADIO_SERVER_NAME"] == "127.0.0.1"
    assert gradio.env["GRADIO_SERVER_PORT"] == "{port}" and gradio.env["GRADIO_ROOT_PATH"] == "{base_path}"


def test_r_preset_runs_a_launcher_with_the_library_setup_first(tmp_path):
    file = tmp_path / "it's" / "app.R"
    spec = RuntimeSpec("Rscript", str(tmp_path), {})
    argv = web_apps.launch_argv(web_apps.preset("shiny"), spec, file, 8706, "/b/", tmp_path / "l")
    assert argv[:2] == ["Rscript", "--vanilla"]
    source = Path(argv[2]).read_text()
    assert source.startswith(R_LIB_SETUP)
    # The path is an R string literal, its quote escaped.
    assert "'" + str(file.parent).replace("'", "\\'") + "'" in source
    assert "port = 8706" in source and "host = '127.0.0.1'" in source


def test_app_env_has_a_path_and_no_api_secret(monkeypatch):
    monkeypatch.setenv("LINKR_SECRET_KEY", "jwt-signing")
    monkeypatch.setenv("LINKR_DATABASE_URL", "postgresql://u:pw@h/db")
    spec = RuntimeSpec("/venv/bin/python", "/p", {"LINKR_PROJECT_UID": "p"})
    env = web_apps.app_env(spec, 8701, "/b/", {"EXTRA": "1"})
    assert "LINKR_SECRET_KEY" not in env and "LINKR_DATABASE_URL" not in env
    assert env["PATH"].startswith("/venv/bin" + os.pathsep) and len(env["PATH"]) > len("/venv/bin:")
    assert env["PORT"] == "8701" and env["LINKR_PROJECT_UID"] == "p" and env["EXTRA"] == "1"
    # Rscript is found on PATH, not by an absolute path.
    assert "PATH" in web_apps.app_env(RuntimeSpec("Rscript", "/p", {}), 8701, "/b/", {})


def test_custom_r_command_reads_the_library_setup(tmp_path):
    env = web_apps.custom_r_profile(tmp_path)
    assert Path(env["R_PROFILE_USER"]).read_text() == R_LIB_SETUP


def test_location_rewritten_into_the_mount_point():
    app = _app()
    assert web_apps_location("/login", app) == "/docker-1/api/v1/apps/abc/proxy/login"
    assert web_apps_location("http://127.0.0.1:8701/a?b=1", app) == "/docker-1/api/v1/apps/abc/proxy/a?b=1"
    assert web_apps_location("/docker-1/api/v1/apps/abc/proxy/x", app) == "/docker-1/api/v1/apps/abc/proxy/x"
    assert web_apps_location("https://example.org/", app) == "https://example.org/"
    assert web_apps_location("next", app) == "next"


def web_apps_location(value, app):
    return apps_route._rewrite_location(value, app)


def test_cookie_keeps_its_name_and_is_scoped_to_the_app():
    app = _app()
    assert apps_route._rewrite_cookie("_streamlit_xsrf=1; Path=/; HttpOnly", app) == (
        "_streamlit_xsrf=1; Path=/docker-1/api/v1/apps/abc/proxy/; HttpOnly"
    )
    assert apps_route._rewrite_cookie("a=1; path=/x", app) == "a=1; path=/docker-1/api/v1/apps/abc/proxy/x"
    assert apps_route._rewrite_cookie("nameless; Path=/", app) is None
    assert apps_route._rewrite_cookie(f"{apps_route._session_cookie(app.app_id)}=forged; Path=/", app) is None
    assert app.cookie_names == {"_streamlit_xsrf", "a"}


def test_only_the_apps_own_cookies_and_no_linkr_credential_reach_it(monkeypatch):
    monkeypatch.setattr(apps_route.settings, "trusted_header", "X-Remote-User")
    app = _app()
    app.cookie_names.update({"sid", "theme"})
    session = apps_route._session_cookie(app.app_id)
    sent = {
        "host": "localhost",
        "cookie": f"spe_session=s3cret; sid=1; {session}=tok; theme=dark",
        "authorization": "Bearer jwt",
        "x-linkr-proxy-secret": "shared",
        "x-remote-user": "alice",
        "accept": "text/html",
    }
    headers = dict(apps_route._forwarded(sent, {}, app))
    assert headers["cookie"] == "sid=1; theme=dark"
    assert headers["accept"] == "text/html"
    for name in ("authorization", "x-linkr-proxy-secret", "x-remote-user"):
        assert name not in headers
    # No cookie of the app's own: no Cookie header at all.
    assert "cookie" not in dict(apps_route._forwarded({"host": "h", "cookie": "spe_session=s3cret"}, {}, _app()))


def test_response_cannot_widen_a_service_worker_scope():
    upstream = httpx.Headers({"service-worker-allowed": "/", "set-cookie": "sid=1; Path=/"})
    out = apps_route._response_headers(upstream, _app())
    names = [k for k, _ in out]
    assert "service-worker-allowed" not in names
    assert ("set-cookie", "sid=1; Path=/docker-1/api/v1/apps/abc/proxy/") in out


def test_origin_check_ignores_a_port_the_gateway_dropped():
    same = apps_route._same_origin
    assert same({"origin": "https://localhost:8443", "host": "localhost"}, {})
    assert same({"origin": "https://spe.chu.fr", "host": "web", "x-forwarded-host": "spe.chu.fr"}, {})
    assert same({"host": "localhost"}, {})
    assert not same({"origin": "https://evil.example", "host": "localhost"}, {})
    assert not same({"origin": "null", "host": "localhost"}, {})


def test_upstream_path_keeps_encoding_and_query():
    scope = {"path": "/api/v1/apps/abc/proxy/a b", "raw_path": b"/api/v1/apps/abc/proxy/a%20b", "query_string": b"x=1"}
    assert apps_route._upstream_path(scope, "abc") == "/a%20b?x=1"
    assert apps_route._upstream_path({"path": "/api/v1/apps/abc/proxy/", "query_string": b""}, "abc") == "/"


@pytest.mark.parametrize("escape", ["%2F", "%3F", "%23", "%2f"])
def test_upstream_path_never_changes_the_host(escape):
    # The router decodes `proxy%2F@evil.example/x` into `proxy/@evil.example/x`, but
    # the raw rest glued to `127.0.0.1:<port>` would name evil.example as the host.
    scope = {"path": "/api/v1/apps/abc/proxy/@evil.example/x", "raw_path": f"/api/v1/apps/abc/proxy{escape}@evil.example/x".encode()}
    assert apps_route._upstream_path(scope, "abc") is None
    scope = {"path": "/api/v1/apps/abc/proxy//@evil.example/x", "raw_path": f"/api/v1/apps/abc/proxy/{escape}@evil.example/x".encode()}
    path = apps_route._upstream_path(scope, "abc")
    assert path == f"/{escape}@evil.example/x"
    assert httpx.URL(scheme="http", host="127.0.0.1", port=8701, raw_path=path.encode()).host == "127.0.0.1"


def test_port_held_by_another_process_is_skipped(monkeypatch):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
        held.bind(("127.0.0.1", 0))
        held.listen()
        port = held.getsockname()[1]
        monkeypatch.setattr(web_apps.settings, "app_port_range", f"{port}-{port + 1}")
        assert web_apps.AppManager()._allocate_port() == port + 1


def test_orphan_reaped_only_when_proven_ours(tmp_path, monkeypatch):
    monkeypatch.setattr(web_apps, "_apps_cache", lambda: tmp_path)
    ours = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        env={**os.environ, "LINKR_APP_ID": "orphan"}, start_new_session=True,
    )
    stranger = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
    try:
        for app_id, proc in (("orphan", ours), ("reused", stranger)):
            (tmp_path / app_id).mkdir()
            (tmp_path / app_id / "pid").write_text(str(proc.pid))
        proven = Path(f"/proc/{ours.pid}/environ").exists()
        assert web_apps.reap_orphans() == (1 if proven else 0)
        assert not list(tmp_path.glob("*/pid"))
        # A process whose identity cannot be proven keeps running.
        assert stranger.poll() is None
        if proven:
            assert ours.wait(timeout=5) == -9
    finally:
        for proc in (ours, stranger):
            proc.kill()
            proc.wait()


async def _admin_headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _project(client, headers) -> str:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    r = await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})
    return r.json()["uid"]


async def _other_user_headers(client, admin_headers) -> dict:
    await client.post(f"{API}/users", headers=admin_headers, json={"username": "bob", "password": "bob-password-1"})
    r = await client.post(f"{API}/auth/login", json={"username": "bob", "password": "bob-password-1"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _session(client, headers, app_id: str) -> dict:
    """The Cookie header a browser would send the app after opening its session."""
    r = await client.post(f"{API}/apps/{app_id}/session", headers=headers)
    assert r.status_code == 204, r.text
    client.cookies.clear()
    name = apps_route._session_cookie(app_id)
    return {"cookie": f"{name}={r.cookies[name]}"}


async def _wait_status(client, headers, app_id: str, until: set[str]) -> dict:
    for _ in range(100):
        body = (await client.get(f"{API}/apps/{app_id}", headers=headers)).json()
        if body["status"] in until:
            return body
        await asyncio.sleep(0.1)
    raise AssertionError(f"app stayed {body['status']}: {body['log']}")


async def test_custom_command_served_through_the_proxy_then_stopped(client):
    headers = await _admin_headers(client)
    project = await _project(client, headers)
    (project_fs.scripts_dir(project) / "hello.txt").write_text("hello from the app")

    r = await client.post(f"{API}/apps", headers=headers, json={
        "projectUid": project, "path": "hello.txt",
        "command": 'python -m http.server "$PORT" --bind 127.0.0.1',
        "publicPrefix": "/docker-1",
    })
    assert r.status_code == 201, r.text
    started = r.json()
    assert started["url"] == f"/docker-1/api/v1/apps/{started['appId']}/proxy/"
    await _wait_status(client, headers, started["appId"], {"ready"})

    # Behind a gateway the browser sees the app under the gateway's prefix, and
    # its session cookie must be scoped there.
    r = await client.post(f"{API}/apps/{started['appId']}/session", headers=headers)
    set_cookie = r.headers["set-cookie"]
    assert f"Path=/docker-1/api/v1/apps/{started['appId']}/proxy/" in set_cookie
    assert "HttpOnly" in set_cookie and "SameSite=strict" in set_cookie and "Secure" not in set_cookie
    cookie = await _session(client, headers, started["appId"])
    page = await client.get(f"{API}/apps/{started['appId']}/proxy/hello.txt", headers=cookie)
    assert page.status_code == 200 and page.text == "hello from the app"
    assert "x-frame-options" not in page.headers
    assert "frame-ancestors" in page.headers["content-security-policy"]

    smuggled = await client.get(f"{API}/apps/{started['appId']}/proxy%2F@evil.example/x", headers=cookie)
    assert smuggled.status_code == 400

    pid = web_apps.manager.get(started["appId"]).proc.pid
    assert (await client.delete(f"{API}/apps/{started['appId']}", headers=headers)).status_code == 204
    await _wait_status(client, headers, started["appId"], {"stopped"})
    gone = await client.get(f"{API}/apps/{started['appId']}/proxy/hello.txt", headers=cookie)
    assert gone.status_code == 404
    try:
        os.kill(pid, 0)
        alive = True
    except ProcessLookupError:
        alive = False
    assert not alive


_ECHO = """
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

class Echo(BaseHTTPRequestHandler):
    def _answer(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        out = f"{self.headers.get('Transfer-Encoding', 'none')}|{body.decode()}".encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)
    do_GET = do_POST = _answer

HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Echo).serve_forever()
"""


async def test_requests_reach_the_app_as_sent(client):
    # httpuv (Shiny for R) answers a GET with a chunked body by 413.
    headers = await _admin_headers(client)
    project = await _project(client, headers)
    (project_fs.scripts_dir(project) / "echo.py").write_text(_ECHO)
    r = await client.post(f"{API}/apps", headers=headers, json={
        "projectUid": project, "path": "echo.py", "command": "python echo.py",
    })
    app_id = r.json()["appId"]
    await _wait_status(client, headers, app_id, {"ready"})
    cookie = await _session(client, headers, app_id)
    assert (await client.get(f"{API}/apps/{app_id}/proxy/", headers=cookie)).text == "none|"
    posted = await client.post(f"{API}/apps/{app_id}/proxy/", content=b"a=1", headers=cookie)
    assert posted.text == "none|a=1"
    await client.delete(f"{API}/apps/{app_id}", headers=headers)


async def test_an_app_that_exits_reports_its_output(client):
    headers = await _admin_headers(client)
    project = await _project(client, headers)
    (project_fs.scripts_dir(project) / "x.py").write_text("")
    r = await client.post(f"{API}/apps", headers=headers, json={
        "projectUid": project, "path": "x.py", "command": "echo nope >&2; exit 3",
    })
    body = await _wait_status(client, headers, r.json()["appId"], {"failed", "stopped"})
    assert body["status"] == "failed"
    assert "nope" in "\n".join(body["log"])


async def test_unrecognised_file_needs_a_command(client):
    headers = await _admin_headers(client)
    project = await _project(client, headers)
    (project_fs.scripts_dir(project) / "x.py").write_text("print(1)")
    r = await client.post(f"{API}/apps", headers=headers, json={"projectUid": project, "path": "x.py"})
    assert r.status_code == 422


async def test_path_cannot_leave_the_scripts_folder(client):
    headers = await _admin_headers(client)
    project = await _project(client, headers)
    r = await client.post(f"{API}/apps", headers=headers, json={
        "projectUid": project, "path": "../../etc/passwd", "command": "true",
    })
    assert r.status_code == 400


async def test_quota_per_user(client, monkeypatch):
    monkeypatch.setattr(web_apps.settings, "max_apps_per_user", 1)
    headers = await _admin_headers(client)
    project = await _project(client, headers)
    (project_fs.scripts_dir(project) / "x.py").write_text("")
    body = {"projectUid": project, "path": "x.py", "command": "sleep 30"}
    first = await client.post(f"{API}/apps", headers=headers, json=body)
    assert first.status_code == 201
    assert (await client.post(f"{API}/apps", headers=headers, json=body)).status_code == 429
    listed = (await client.get(f"{API}/apps", headers=headers, params={"projectUid": project})).json()
    assert [a["appId"] for a in listed] == [first.json()["appId"]]
    await client.delete(f"{API}/apps/{first.json()['appId']}", headers=headers)
    await _wait_status(client, headers, first.json()["appId"], {"stopped"})


async def test_an_idle_app_is_stopped_without_anyone_listing(client, monkeypatch):
    monkeypatch.setattr(web_apps, "_SWEEP_SECONDS", 0.05)
    headers = await _admin_headers(client)
    project = await _project(client, headers)
    (project_fs.scripts_dir(project) / "x.py").write_text("")
    r = await client.post(f"{API}/apps", headers=headers, json={
        "projectUid": project, "path": "x.py", "command": "sleep 30",
    })
    app = web_apps.manager.get(r.json()["appId"])
    sweeper = asyncio.create_task(web_apps.run_idle_sweeper())
    try:
        app.last_seen = time.monotonic() - web_apps.settings.app_idle_timeout_minutes * 60 - 1
        deadline = time.monotonic() + 10
        while app.status != "stopped" or (app.task and not app.task.done()):
            assert time.monotonic() < deadline, app.status
            await asyncio.sleep(0.05)
    finally:
        sweeper.cancel()
    assert app.proc.returncode is not None


async def test_the_open_tab_polling_keeps_an_app_from_going_idle(client):
    headers = await _admin_headers(client)
    project = await _project(client, headers)
    (project_fs.scripts_dir(project) / "x.py").write_text("")
    r = await client.post(f"{API}/apps", headers=headers, json={
        "projectUid": project, "path": "x.py", "command": "sleep 30",
    })
    app = web_apps.manager.get(r.json()["appId"])
    try:
        stale = time.monotonic() - web_apps.settings.app_idle_timeout_minutes * 60 - 1
        app.last_seen = stale
        assert (await client.get(f"{API}/apps/{app.app_id}", headers=headers)).status_code == 200
        assert app.last_seen > stale + 1
    finally:
        await client.delete(f"{API}/apps/{app.app_id}", headers=headers)
        await _wait_status(client, headers, app.app_id, {"stopped"})


async def test_app_output_reaches_the_job_while_it_runs(client, monkeypatch):
    monkeypatch.setattr(web_apps, "_LOG_FLUSH_SECONDS", 0.1)
    headers = await _admin_headers(client)
    project = await _project(client, headers)
    (project_fs.scripts_dir(project) / "x.py").write_text("")
    r = await client.post(f"{API}/apps", headers=headers, json={
        "projectUid": project, "path": "x.py", "command": "echo serving; sleep 30",
    })
    started = r.json()
    try:
        deadline = time.monotonic() + 10
        while True:
            async with jobs.async_session() as db:
                job = await db.get(Job, started["jobId"])
                log = job.log_tail or ""
            if "serving" in log:
                break
            assert time.monotonic() < deadline, log
            await asyncio.sleep(0.1)
    finally:
        await client.delete(f"{API}/apps/{started['appId']}", headers=headers)
        await _wait_status(client, headers, started["appId"], {"stopped"})


def test_session_cookie_names_the_app_its_owner_and_an_expiry():
    app = _app(status="ready")
    name = apps_route._session_cookie("abc")
    later = int(time.time()) + 60
    valid = apps_route.session_token("abc", 1, later)
    assert apps_route._session_valid({name: valid}, app)
    assert not apps_route._session_valid({}, app)
    assert not apps_route._session_valid({name: apps_route.session_token("abc", 1, int(time.time()) - 1)}, app)
    assert not apps_route._session_valid({name: apps_route.session_token("abc", 2, later)}, app)
    assert not apps_route._session_valid({name: apps_route.session_token("xyz", 1, later)}, app)
    assert not apps_route._session_valid({name: valid.replace(".1.", ".2.")}, app)
    assert not apps_route._session_valid({name: valid[:-1] + ("0" if valid[-1] != "0" else "1")}, app)
    assert not apps_route._session_valid({name: "garbage"}, app)


def _ws_close_code(path: str, cookie: str | None) -> int:
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from app.main import app as asgi

    headers = {"cookie": cookie} if cookie else {}
    try:
        with TestClient(asgi).websocket_connect(path, headers=headers):
            pass
    except WebSocketDisconnect as e:
        return e.code
    raise AssertionError("the handshake was accepted")


def test_websocket_needs_its_owners_session(monkeypatch):
    # Nothing listens on the port: an accepted session reaches the upstream
    # connect and fails there (1011); a refused one never gets that far (1008).
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    app = _app(app_id="wsapp", port=port, status="ready", base_path="/api/v1/apps/wsapp/proxy/")
    monkeypatch.setitem(web_apps.manager._apps, "wsapp", app)

    async def owner_may_run(_app, _issued_us) -> bool:
        return True

    monkeypatch.setattr(apps_route, "_owner_may_run", owner_may_run)
    name = apps_route._session_cookie("wsapp")
    later = int(time.time()) + 60
    path = "/api/v1/apps/wsapp/proxy/ws"
    assert _ws_close_code(path, f"{name}={apps_route.session_token('wsapp', 1, later)}") == 1011
    for cookie in (
        None,
        f"{name}={apps_route.session_token('wsapp', 1, int(time.time()) - 1)}",
        f"{name}={apps_route.session_token('wsapp', 2, later)}",
        f"{name}={apps_route.session_token('wsapp', 1, later)[:-2]}00",
    ):
        assert _ws_close_code(path, cookie) == 1008, cookie


async def test_only_the_owner_reaches_an_app(client):
    headers = await _admin_headers(client)
    other = await _other_user_headers(client, headers)
    project = await _project(client, headers)
    (project_fs.scripts_dir(project) / "hello.txt").write_text("hello")
    r = await client.post(f"{API}/apps", headers=headers, json={
        "projectUid": project, "path": "hello.txt",
        "command": 'python -m http.server "$PORT" --bind 127.0.0.1',
    })
    app_id = r.json()["appId"]
    await _wait_status(client, headers, app_id, {"ready"})
    url = f"{API}/apps/{app_id}/proxy/hello.txt"
    name = apps_route._session_cookie(app_id)
    try:
        owner = await _session(client, headers, app_id)
        assert (await client.get(url, headers=owner)).status_code == 200

        later = int(time.time()) + 60
        refused = [
            {},
            {"cookie": f"{name}={apps_route.session_token(app_id, 1, int(time.time()) - 1)}"},
            {"cookie": owner["cookie"][:-2] + "00"},
        ]
        assert (await client.post(f"{API}/apps/{app_id}/session", headers=other)).status_code == 404
        client.cookies.clear()
        bob_id = (await client.get(f"{API}/auth/me", headers=other)).json()["id"]
        refused.append({"cookie": f"{name}={apps_route.session_token(app_id, bob_id, later)}"})
        for cookie in refused:
            assert (await client.get(url, headers=cookie)).status_code == 404, cookie

        assert (await client.get(f"{API}/apps/{app_id}", headers=other)).status_code == 404
        assert (await client.delete(f"{API}/apps/{app_id}", headers=other)).status_code == 404
        assert web_apps.manager.running(app_id) is not None
    finally:
        await client.delete(f"{API}/apps/{app_id}", headers=headers)
        await _wait_status(client, headers, app_id, {"stopped"})
