"""A repository may track files the export leaves out until the user marks them
(data files under scripts/, notebooks whose outputs cannot be stripped). A data
file reaches a remote only once the user marked it: the status reports these
files for the user to mark, and no route marks them on the user's behalf."""

import subprocess

from sqlalchemy import select

from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.workspace import Workspace
from app.services import project_fs
from app.services.project_export import tracked_files_left_out
from tests.test_workspace_hidden_projects import _member

API = "/api/v1"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _remote_with(tmp_path, files: dict[str, str]) -> str:
    bare = tmp_path / "remote.git"
    work = tmp_path / "seed"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(bare)], check=True, capture_output=True)
    subprocess.run(["git", "init", "-b", "main", str(work)], check=True, capture_output=True)
    for path, content in files.items():
        target = work / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    git = ["git", "-C", str(work), "-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run([*git, "add", "-A"], check=True, capture_output=True)
    subprocess.run([*git, "commit", "-q", "-m", "seed"], check=True, capture_output=True)
    subprocess.run([*git, "push", "-q", str(bare), "main"], check=True, capture_output=True)
    return f"file://{bare}"


async def _marks(db, uid: str) -> list:
    project = (await db.execute(select(Project).where(Project.uid == uid))).scalar_one()
    await db.refresh(project)
    return (project.config or {}).get("versionedDataFiles") or []


def test_tracked_files_left_out_lists_unmarked_data_and_unstrippable_notebooks_only():
    texts = {
        "scripts/config.json": "{}",
        "scripts/out/cohort.rds": "RDS",
        "scripts/reference.csv": "a,b",
        "scripts/old.ipynb": '{"nbformat": 3}',
        "scripts/new.ipynb": '{"cells": [], "nbformat": 4}',
        "scripts/analysis.py": "x = 1",
        "scripts/excluded.txt": "x",
        "scripts/marked.txt": "x",
    }
    tracked = {*texts, "scripts/gone.txt", "project.json", "dashboards/d.json"}
    left_out = tracked_files_left_out(
        tracked, {"scripts/marked.txt"}, {"scripts/excluded.txt"}, lambda p: p in texts, texts.get,
    )
    # A code file and a strippable notebook are exported anyway; a file gone from
    # the project is a genuine deletion.
    assert left_out == ["scripts/config.json", "scripts/old.ipynb", "scripts/out/cohort.rds", "scripts/reference.csv"]


async def test_a_tracked_data_file_is_reported_not_marked(client, db, tmp_path):
    headers = await _admin(client)
    url = _remote_with(tmp_path, {
        "scripts/out/cohort.rds": "RDS",
        "scripts/broken.ipynb": "not json",
        "scripts/run.py": "print(1)",
    })
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    r = await client.post(
        f"{API}/projects", headers=headers,
        json={"workspaceId": ws, "uid": "p-tracked", "name": {"en": "P"}, "gitRemoteConfig": {"url": url, "branch": "main"}},
    )
    assert r.status_code == 201
    scripts = project_fs.scripts_dir("p-tracked")
    (scripts / "out").mkdir(parents=True, exist_ok=True)
    (scripts / "out" / "cohort.rds").write_text("RDS")
    (scripts / "broken.ipynb").write_text("not json")
    (scripts / "run.py").write_text("print(1)")

    r = await client.post(f"{API}/git/projects/p-tracked/status", headers=headers, data={"branch": "main"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["trackedUnmarked"] == [
        {"path": "scripts/broken.ipynb", "projectUid": "p-tracked", "key": "scripts/broken.ipynb"},
        {"path": "scripts/out/cohort.rds", "projectUid": "p-tracked", "key": "scripts/out/cohort.rds"},
    ]
    deleted = {f["path"] for f in body["files"] if f["changeType"] == "deleted"}
    assert {"scripts/out/cohort.rds", "scripts/broken.ipynb"} <= deleted
    # A code file the remote tracks stays in the export with no mark.
    assert "scripts/run.py" not in deleted
    assert await _marks(db, "p-tracked") == []

    r = await client.post(f"{API}/git/projects/p-tracked/three-way", headers=headers, data={"branch": "main"})
    assert r.status_code == 200, r.text
    assert await _marks(db, "p-tracked") == []

    # Marked by the user, it leaves the report and the push carries it.
    project = (await db.execute(select(Project).where(Project.uid == "p-tracked"))).scalar_one()
    project.config = {**(project.config or {}), "versionedDataFiles": ["scripts/broken.ipynb"]}
    await db.commit()
    body = (await client.post(f"{API}/git/projects/p-tracked/status", headers=headers, data={"branch": "main"})).json()
    assert [f["key"] for f in body["trackedUnmarked"]] == ["scripts/out/cohort.rds"]
    assert body["markedForVersioning"] == ["scripts/broken.ipynb"]


async def test_workspace_status_reports_tracked_files_only_for_projects_the_caller_may_write(client, db, tmp_path):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    uids = {}
    for slug in ("mine", "theirs"):
        r = await client.post(
            f"{API}/projects", headers=headers,
            json={"workspaceId": ws, "uid": f"p-{slug}", "entityId": slug, "name": {"en": slug}},
        )
        assert r.status_code == 201, r.text
        uids[slug] = r.json()["uid"]
        (project_fs.scripts_dir(uids[slug]) / "cohort.tsv").write_text("id\n1")
    url = _remote_with(tmp_path, {
        "projects/mine/scripts/cohort.tsv": "id\n1",
        "projects/theirs/scripts/cohort.tsv": "id\n1",
    })
    workspace = await db.get(Workspace, ws)
    workspace.git_remote_config = {"url": url, "branch": "main"}
    await db.commit()

    bob_id, bob = await _member(client, db, ws, "bob", "editor")
    db.add(ProjectMember(project_uid=uids["theirs"], user_id=bob_id, role="viewer"))
    await db.commit()

    r = await client.post(f"{API}/git/workspaces/{ws}/status", headers=bob, data={"branch": "main"})
    assert r.status_code == 200, r.text
    reported = r.json()["trackedUnmarked"]
    assert [f["path"] for f in reported] == ["projects/mine/scripts/cohort.tsv"]
    assert "theirs" not in str(reported) and uids["theirs"] not in str(reported)
    for uid in uids.values():
        assert await _marks(db, uid) == []

    r = await client.post(f"{API}/git/workspaces/{ws}/status", headers=headers, data={"branch": "main"})
    assert {f["path"] for f in r.json()["trackedUnmarked"]} == {
        "projects/mine/scripts/cohort.tsv", "projects/theirs/scripts/cohort.tsv",
    }
