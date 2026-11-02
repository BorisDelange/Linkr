"""Web apps started from the IDE (services/execution/web_apps.py) and the proxy
that serves them (routes/apps.py)."""

import asyncio
import os
import re
from pathlib import Path

from app.api.v1.routes import apps as apps_route
from app.services import project_fs
from app.services.execution import web_apps
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


def test_cookie_scoped_to_the_app():
    app = _app()
    assert apps_route._rewrite_cookie("sid=1; Path=/; HttpOnly", app) == (
        "sid=1; Path=/docker-1/api/v1/apps/abc/proxy/; HttpOnly"
    )
    assert apps_route._rewrite_cookie("a=1; path=/x", app) == "a=1; path=/docker-1/api/v1/apps/abc/proxy/x"


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


async def _admin_headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _project(client, headers) -> str:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    r = await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})
    return r.json()["uid"]


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

    # The proxy needs no Linkr credentials: the app id is the capability.
    page = await client.get(f"{API}/apps/{started['appId']}/proxy/hello.txt")
    assert page.status_code == 200 and page.text == "hello from the app"
    assert "x-frame-options" not in page.headers
    assert "frame-ancestors" in page.headers["content-security-policy"]

    pid = web_apps.manager.get(started["appId"]).proc.pid
    assert (await client.delete(f"{API}/apps/{started['appId']}", headers=headers)).status_code == 204
    await _wait_status(client, headers, started["appId"], {"stopped"})
    gone = await client.get(f"{API}/apps/{started['appId']}/proxy/hello.txt")
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
    assert (await client.get(f"{API}/apps/{app_id}/proxy/")).text == "none|"
    posted = await client.post(f"{API}/apps/{app_id}/proxy/", content=b"a=1")
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
