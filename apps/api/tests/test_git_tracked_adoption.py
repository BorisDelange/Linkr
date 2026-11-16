"""A project repository that already tracks files the export now leaves out unless
marked (non-code files under scripts/, notebooks that cannot be stripped) keeps
them: the first status marks them once, so the next push does not delete them."""

import subprocess

from sqlalchemy import select

from app.models.project import Project
from app.services import project_fs
from app.services.project_export import tracked_files_to_adopt

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


def test_only_files_the_export_now_leaves_out_are_adopted():
    texts = {
        "scripts/config.json": "{}",
        "scripts/figures/plot.png": "PNG",
        "scripts/old.ipynb": '{"nbformat": 3}',
        "scripts/new.ipynb": '{"cells": [], "nbformat": 4}',
        "scripts/reference.csv": "a,b",
        "scripts/analysis.py": "x = 1",
        "scripts/excluded.txt": "x",
        "scripts/marked.txt": "x",
    }
    tracked = {*texts, "scripts/gone.txt", "project.json", "dashboards/d.json"}
    adopt = tracked_files_to_adopt(tracked, {"scripts/marked.txt"}, {"scripts/excluded.txt"}, texts.get)
    # A legacy data file (.csv) was already left out before; a strippable notebook
    # and a code file are exported anyway; a file gone from the project stays gone.
    assert adopt == ["scripts/config.json", "scripts/figures/plot.png", "scripts/old.ipynb"]


async def test_status_marks_tracked_files_once_and_keeps_them_in_the_export(client, db, tmp_path):
    headers = await _admin(client)
    url = _remote_with(tmp_path, {"scripts/config.json": '{"k": 1}', "scripts/run.py": "print(1)"})
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    r = await client.post(
        f"{API}/projects", headers=headers,
        json={"workspaceId": ws, "uid": "p-adopt", "name": {"en": "P"}, "gitRemoteConfig": {"url": url, "branch": "main"}},
    )
    assert r.status_code == 201
    scripts = project_fs.scripts_dir("p-adopt")
    (scripts / "config.json").write_text('{"k": 1}')
    (scripts / "run.py").write_text("print(1)")

    r = await client.post(f"{API}/git/projects/p-adopt/status", headers=headers, data={"branch": "main"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["adopted"] is True
    assert "scripts/config.json" not in {f["path"] for f in body["files"] if f["changeType"] == "deleted"}
    project = (await db.execute(select(Project).where(Project.uid == "p-adopt"))).scalar_one()
    await db.refresh(project)
    assert "scripts/config.json" in project.config["versionedDataFiles"]

    # Unmarked by the user afterwards: the adoption does not run again, so the push
    # may delete it (the confirmation lists it).
    project.config = {**project.config, "versionedDataFiles": []}
    await db.commit()
    r = await client.post(f"{API}/git/projects/p-adopt/status", headers=headers, data={"branch": "main"})
    body = r.json()
    assert body["adopted"] is False
    assert {"path": "scripts/config.json", "changeType": "deleted"}.items() <= next(
        f for f in body["files"] if f["path"] == "scripts/config.json"
    ).items()
