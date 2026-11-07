"""What a user started stays theirs only while they keep the right that started it.

A job's output and a web app's log come from the project's data: once its owner
no longer holds access to the project, they read neither, and an app whose owner
may no longer run code stops.
"""

import asyncio
import time

from app.models.job import Job
from app.services.execution import web_apps

API = "/api/v1"


async def _login(client, username: str) -> dict:
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _setup(client) -> tuple[dict, dict, int, str, str]:
    """(admin, editor headers, editor id, workspace id, project uid)."""
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    admin = await _login(client, "admin")
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=admin, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    await client.post(f"{API}/users", headers=admin, json={"username": "ed", "password": "pw-for-tests-only", "role": "user"})
    ed_id = next(u["id"] for u in (await client.get(f"{API}/users", headers=admin)).json() if u["username"] == "ed")
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": ed_id, "role": "editor"})
    return admin, await _login(client, "ed"), ed_id, ws, uid


async def _job(db, user_id: int, *, project_uid: str | None = None, workspace_id: str | None = None) -> str:
    job = Job(project_uid=project_uid, workspace_id=workspace_id, user_id=user_id, kind="run",
              label="run", status="done", log_tail="DUMMY-OUTPUT-ROW 42", input="print(42)")
    db.add(job)
    await db.commit()
    return job.id


async def test_a_removed_member_no_longer_reads_their_jobs(client, db):
    admin, ed, ed_id, ws, uid = await _setup(client)
    project_job = await _job(db, ed_id, project_uid=uid)
    workspace_job = await _job(db, ed_id, workspace_id=ws)
    for job_id in (project_job, workspace_job):
        r = await client.get(f"{API}/jobs/{job_id}?withInput=true", headers=ed)
        assert r.status_code == 200 and "DUMMY-OUTPUT-ROW" in r.json()["logTail"]

    assert (await client.delete(f"{API}/workspaces/{ws}/members/{ed_id}", headers=admin)).status_code == 204
    for job_id in (project_job, workspace_job):
        r = await client.get(f"{API}/jobs/{job_id}?withInput=true", headers=ed)
        assert r.status_code == 404 and "DUMMY-OUTPUT-ROW" not in r.text


def _fake_app(app_id: str, project_uid: str, user_id: int) -> web_apps.WebApp:
    app = web_apps.WebApp(
        app_id=app_id, project_uid=project_uid, user_id=user_id, label="app.py", path="app.py",
        framework="custom", command="", port=8701, base_path=f"/api/v1/apps/{app_id}/proxy/",
        job_id="j", proc=None, status="ready",
    )
    app.log.append("dummy-row-1")
    app.task = asyncio.create_task(asyncio.sleep(60))
    return app


async def test_a_user_who_lost_code_execution_no_longer_reads_or_keeps_alive_their_app(client, monkeypatch):
    admin, ed, ed_id, ws, uid = await _setup(client)
    app = _fake_app("revoked-app", uid, ed_id)
    monkeypatch.setitem(web_apps.manager._apps, app.app_id, app)
    try:
        assert (await client.get(f"{API}/apps/{app.app_id}", headers=ed)).status_code == 200

        assert (await client.delete(f"{API}/workspaces/{ws}/members/{ed_id}", headers=admin)).status_code == 204
        stale = time.monotonic() - 10
        app.last_seen = stale
        r = await client.get(f"{API}/apps/{app.app_id}", headers=ed)
        assert r.status_code == 404 and "dummy-row" not in r.text
        assert app.last_seen == stale
        assert app.status == "stopped"
    finally:
        app.task.cancel()


async def test_the_sweeper_stops_an_app_whose_owner_may_no_longer_run_code(client, monkeypatch):
    admin, _, ed_id, ws, uid = await _setup(client)
    kept = _fake_app("kept-app", uid, 1)
    revoked = _fake_app("revoked-app", uid, ed_id)
    monkeypatch.setitem(web_apps.manager._apps, kept.app_id, kept)
    monkeypatch.setitem(web_apps.manager._apps, revoked.app_id, revoked)
    try:
        await web_apps.manager.stop_unpermitted()
        assert revoked.status == "ready" and kept.status == "ready"

        assert (await client.delete(f"{API}/workspaces/{ws}/members/{ed_id}", headers=admin)).status_code == 204
        await web_apps.manager.stop_unpermitted()
        assert revoked.status == "stopped"
        assert kept.status == "ready"
    finally:
        kept.task.cancel()
        revoked.task.cancel()


async def test_the_proxy_root_redirect_never_leaves_the_origin(client):
    for segment in ("http:evil.example", "https:evil.example", "http%3Aevil.example", "abc"):
        r = await client.get(f"{API}/apps/{segment}/proxy", follow_redirects=False)
        assert r.status_code == 307
        assert r.headers["location"] == "proxy/"
