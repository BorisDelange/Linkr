"""Two people on one workspace repository: the push anchors the workspace, a
second editor's push makes the first one behind (and refused), and the three-way
hands back BASE, LOCAL and REMOTE of what came in for the client's merge.
Every remote is a bare repository on this machine."""

import hashlib
import io
import json
import subprocess
import zipfile

import pytest

from app.services import git_service as g

API = "/api/v1"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


def _git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout


async def _linked_workspace(client, headers, tmp_path) -> tuple[str, str]:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(remote)], check=True, capture_output=True)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    r = await client.patch(
        f"{API}/workspaces/{ws}", headers=headers,
        json={"gitRemoteConfig": {"url": f"file://{remote}", "branch": "main"}},
    )
    assert r.status_code == 200
    return ws, f"file://{remote}"


async def _three_way(client, headers, ws, files: dict[str, str]):
    return await client.post(
        f"{API}/git/workspaces/{ws}/three-way", headers=headers,
        data={"branch": "main"}, files={"file": ("ws.zip", _zip(files), "application/zip")},
    )


async def _push(client, headers, ws, files: dict[str, str], message="m"):
    return await client.post(
        f"{API}/git/workspaces/{ws}/commit-push", headers=headers,
        data={"message": message, "branch": "main", "paths": list(files)},
        files={"file": ("ws.zip", _zip(files), "application/zip")},
    )


def _other_editor_pushes(tmp_path, remote_url: str, path: str, content: str) -> None:
    clone = tmp_path / "bob"
    subprocess.run(["git", "clone", "-q", remote_url, str(clone)], check=True, capture_output=True)
    _git(clone, "config", "user.email", "bob@example.org")
    _git(clone, "config", "user.name", "Bob")
    (clone / path).parent.mkdir(parents=True, exist_ok=True)
    (clone / path).write_text(content)
    _git(clone, "add", path)
    _git(clone, "commit", "-q", "-m", "bob")
    _git(clone, "push", "-q", "origin", "main")


async def test_second_editor_makes_the_workspace_behind_and_the_push_wait(client, tmp_path):
    headers = await _admin(client)
    ws, remote = await _linked_workspace(client, headers, tmp_path)

    r = await _push(client, headers, ws, {"wiki/home.md": "Hello\n"})
    assert r.status_code == 200 and r.json()["pushed"]
    state = (await client.get(f"{API}/git/workspaces/{ws}/sync-state", headers=headers)).json()
    assert state["linked"] and not state["behind"]

    _other_editor_pushes(tmp_path, remote, "wiki/home.md", "Hello from Bob\n")

    state = (await client.get(f"{API}/git/workspaces/{ws}/sync-state", headers=headers)).json()
    assert state["behind"]
    # The push no longer overwrites Bob's commit: it waits for a pull.
    r = await _push(client, headers, ws, {"wiki/home.md": "Hello, mine\n"})
    assert r.status_code == 400 and "pull_required" in r.text

    preview = (await _three_way(client, headers, ws, {"wiki/home.md": "Hello, mine\n"})).json()
    [home] = preview["files"]
    assert (home["path"], home["base"], home["remote"]) == ("wiki/home.md", "Hello\n", "Hello from Bob\n")

    # The pull is applied by the client; it then anchors on the remote head.
    r = await client.post(
        f"{API}/git/workspaces/{ws}/set-sync-state", headers=headers,
        json={"branch": "main", "syncedOid": preview["remoteHead"]},
    )
    assert r.status_code == 204
    state = (await client.get(f"{API}/git/workspaces/{ws}/sync-state", headers=headers)).json()
    assert not state["behind"]
    r = await _push(client, headers, ws, {"wiki/home.md": "Hello from Bob, and me\n"})
    assert r.status_code == 200 and r.json()["pushed"]


def _lfs_pointer(content: bytes) -> str:
    return (
        "version https://git-lfs.github.com/spec/v1\n"
        f"oid sha256:{hashlib.sha256(content).hexdigest()}\nsize {len(content)}\n"
    )


async def test_a_file_in_lfs_is_whole_and_compared_by_its_content(client, tmp_path):
    headers = await _admin(client)
    ws, remote = await _linked_workspace(client, headers, tmp_path)
    clone = tmp_path / "bob"
    subprocess.run(["git", "clone", "-q", remote, str(clone)], check=True, capture_output=True)
    _git(clone, "config", "user.email", "bob@example.org")
    _git(clone, "config", "user.name", "Bob")
    (clone / "workspace.json").write_text("{}")
    (clone / "big.csv").write_text(_lfs_pointer(b"a,b\n1,2\n"))
    (clone / "same.csv").write_text(_lfs_pointer(b"x\n"))
    _git(clone, "add", "-A")
    _git(clone, "commit", "-q", "-m", "base")
    _git(clone, "push", "-q", "origin", "main")
    r = await client.post(
        f"{API}/git/workspaces/{ws}/set-sync-state", headers=headers,
        json={"branch": "main", "syncedOid": _git(clone, "rev-parse", "HEAD").strip()},
    )
    assert r.status_code == 204
    (clone / "big.csv").write_text(_lfs_pointer(b"a,b\n1,3\n"))
    (clone / "same.csv").write_text(_lfs_pointer(b"y\n"))
    _git(clone, "commit", "-q", "-am", "bob")
    _git(clone, "push", "-q", "origin", "main")

    # Locally the export holds the content, never the pointer.
    r = await _three_way(client, headers, ws, {"workspace.json": "{}", "big.csv": "a,b\n1,2\n", "same.csv": "y\n"})
    assert r.status_code == 200, r.text
    by_path = {f["path"]: f for f in r.json()["files"]}
    big = by_path["big.csv"]
    assert big["binary"] and big.get("base") is None and big.get("remote") is None
    assert big["localOid"] == big["baseOid"] == f"sha256:{hashlib.sha256(b'a,b\n1,2\n').hexdigest()}"
    assert big["remoteOid"] == f"sha256:{hashlib.sha256(b'a,b\n1,3\n').hexdigest()}"
    # Already what the remote has: nothing to decide on.
    assert by_path["same.csv"]["localOid"] == by_path["same.csv"]["remoteOid"]


@pytest.mark.parametrize(
    ("allowed", "url", "ok"),
    [
        ("localhost:8929", "http://localhost:8929/sandbox/ws.git", True),
        ("localhost:8929", "http://localhost:9000/sandbox/ws.git", False),
        ("gitlab.chu.local", "https://gitlab.chu.local/g/r.git", True),
        ("gitlab.chu.local", "https://127.0.0.1/g/r.git", False),
        ("", "http://localhost:8929/sandbox/ws.git", False),
    ],
)
def test_allowed_git_hosts_let_a_listed_internal_host_through(monkeypatch, allowed, url, ok):
    monkeypatch.setattr(g, "_LOCAL_REMOTES_ALLOWED", False)
    monkeypatch.setattr(g.settings, "git_allowed_hosts", allowed)
    if ok:
        g._reject_internal_host(url)
    else:
        with pytest.raises(g.GitError):
            g._reject_internal_host(url)


def test_http_reaches_git_only_when_hosts_are_listed(monkeypatch):
    monkeypatch.setattr(g, "_LOCAL_REMOTES_ALLOWED", False)
    monkeypatch.setattr(g.settings, "git_allowed_hosts", "")
    assert g._git_env()["GIT_ALLOW_PROTOCOL"] == "https:ssh"
    monkeypatch.setattr(g.settings, "git_allowed_hosts", "localhost:8929")
    assert g._git_env()["GIT_ALLOW_PROTOCOL"] == "https:ssh:http"


async def test_a_project_push_is_anchored_and_waits_for_a_pull(client, tmp_path):
    headers = await _admin(client)
    remote = tmp_path / "project.git"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(remote)], check=True, capture_output=True)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    await client.post(f"{API}/projects", headers=headers, json={
        "workspaceId": ws, "uid": "p-anchor", "name": {"en": "P"},
        "gitRemoteConfig": {"url": f"file://{remote}", "branch": "main"},
    })
    push = lambda files: client.post(
        f"{API}/git/projects/p-anchor/commit-push", headers=headers,
        data={"message": "m", "branch": "main", "paths": list(files)},
        files={"file": ("p.zip", _zip(files), "application/zip")},
    )
    assert (await push({"README.md": "one\n"})).json()["pushed"]
    _other_editor_pushes(tmp_path, f"file://{remote}", "README.md", "theirs\n")
    r = await push({"README.md": "mine\n"})
    assert r.status_code == 400 and "pull_required" in r.text


async def test_a_sql_collection_has_a_sync_state(client, tmp_path):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    c = (await client.post(f"{API}/sql-script-collections", headers=headers, json={"id": "sql-c1", "workspaceId": ws, "name": {"en": "C"}})).json()
    r = await client.get(f"{API}/git/sql-script-collections/{c['id']}/sync-state", headers=headers)
    assert r.status_code == 200 and r.json()["linked"] is False
    r = await client.post(
        f"{API}/git/sql-script-collections/{c['id']}/set-sync-state", headers=headers,
        json={"branch": "main", "syncedOid": "deadbeef"},
    )
    assert r.status_code == 204


async def test_three_way_describes_what_came_in_and_merged_tree_applies_the_choices(client, tmp_path):
    headers = await _admin(client)
    ws, remote = await _linked_workspace(client, headers, tmp_path)
    await _push(client, headers, ws, {"wiki/home.md": "Hello\n", "workspace.json": "{}"})
    clone = tmp_path / "bob"
    subprocess.run(["git", "clone", "-q", remote, str(clone)], check=True, capture_output=True)
    _git(clone, "config", "user.email", "bob@example.org")
    _git(clone, "config", "user.name", "Bob")
    (clone / "wiki" / "home.md").write_text("Hello from Bob\n")
    (clone / "logo.png").write_bytes(b"\x89PNG\x00\x01binary")
    _git(clone, "add", "-A")
    _git(clone, "commit", "-q", "-m", "bob")
    _git(clone, "push", "-q", "origin", "main")

    local = _zip({"wiki/home.md": "Hello, mine\n", "workspace.json": "{}"})
    r = await client.post(
        f"{API}/git/workspaces/{ws}/three-way", headers=headers,
        data={"branch": "main"}, files={"file": ("ws.zip", local, "application/zip")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    by_path = {f["path"]: f for f in body["files"]}
    assert set(by_path) == {"wiki/home.md", "logo.png"}
    home = by_path["wiki/home.md"]
    assert (home["base"], home["local"], home["remote"]) == ("Hello\n", "Hello, mine\n", "Hello from Bob\n")
    assert by_path["logo.png"]["binary"] and by_path["logo.png"]["baseOid"] is None

    r = await client.post(
        f"{API}/git/workspaces/{ws}/merged-tree", headers=headers,
        data={
            "branch": "main", "remoteHead": body["remoteHead"],
            "overrides": json.dumps({"wiki/home.md": {"text": "Merged\n"}, "logo.png": {"remote": True}}),
        },
        files={"file": ("ws.zip", local, "application/zip")},
    )
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        assert zf.read("wiki/home.md") == b"Merged\n"
        assert zf.read("logo.png") == b"\x89PNG\x00\x01binary"
        assert zf.read("workspace.json") == b"{}"

    merged = lambda overrides, files=local: client.post(
        f"{API}/git/workspaces/{ws}/merged-tree", headers=headers,
        data={"branch": "main", "remoteHead": body["remoteHead"], "overrides": json.dumps(overrides)},
        files={"file": ("ws.zip", files, "application/zip")},
    )
    # The decision on home.md was computed on "Hello, mine": an edit made since
    # refuses the tree rather than being overwritten.
    take = {"wiki/home.md": {"text": "Merged\n", "localOid": home["localOid"]},
            "logo.png": {"remote": True, "localOid": None}}
    assert (await merged(take)).status_code == 200
    r = await merged(take, _zip({"wiki/home.md": "Edited meanwhile\n", "workspace.json": "{}", "logo.png": "x"}))
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "local_changed"
    assert r.json()["detail"]["paths"] == ["logo.png", "wiki/home.md"]

    for bad in ({"wiki/home.md": "Merged"}, {"wiki/home.md": {"text": 1}}, {"wiki/home.md": {"remote": True, "delete": True}},
                {"wiki/home.md": {"what": True}}, {"wiki/home.md": {"remote": True, "localOid": 3}}):
        assert (await merged(bad)).status_code == 422, bad
    r = await merged({"../etc/passwd": {"text": "x"}})
    assert r.status_code == 400


async def test_propose_pushes_a_branch_from_the_target_and_records_the_request(client, tmp_path, monkeypatch):
    from app.services import forge_service

    opened: list[dict] = []

    async def fake_detect(url, token):
        return forge_service.Forge("gitlab", "http://forge/api/v4", "sandbox/ws")

    async def fake_open(url, token, **kw):
        opened.append(kw)
        return forge_service.Proposal(12, "http://forge/sandbox/ws/-/merge_requests/12", "open")

    async def fake_read(url, token, number):
        return forge_service.Proposal(number, "http://forge/sandbox/ws/-/merge_requests/12", "merged")

    monkeypatch.setattr(forge_service, "detect", fake_detect)
    monkeypatch.setattr(forge_service, "open_proposal", fake_open)
    monkeypatch.setattr(forge_service, "read_proposal", fake_read)

    headers = await _admin(client)
    ws, remote = await _linked_workspace(client, headers, tmp_path)
    await _push(client, headers, ws, {"wiki/home.md": "Hello\n"})

    r = await client.post(
        f"{API}/git/workspaces/{ws}/propose", headers=headers,
        data={"title": "Wiki: home", "description": "From Linkr", "branch": "main", "paths": ["wiki/home.md"]},
        files={"file": ("ws.zip", _zip({"wiki/home.md": "Hello, proposed\n"}), "application/zip")},
    )
    assert r.status_code == 200, r.text
    proposal = r.json()
    assert proposal["number"] == 12 and proposal["state"] == "open" and proposal["targetBranch"] == "main"
    assert opened[0]["source"] == proposal["branch"] and proposal["branch"].startswith("linkr/admin/")

    # The branch is on the remote, main untouched, and the anchor did not move.
    heads = _git(tmp_path / "remote.git", "for-each-ref", "--format=%(refname:short)", "refs/heads")
    assert proposal["branch"] in heads.split()
    assert _git(tmp_path / "remote.git", "show", "main:wiki/home.md") == "Hello\n"
    assert _git(tmp_path / "remote.git", "show", f"{proposal['branch']}:wiki/home.md") == "Hello, proposed\n"

    listed = (await client.get(f"{API}/git/workspaces/{ws}/proposals", headers=headers)).json()
    assert [(p["number"], p["state"]) for p in listed] == [(12, "merged")]

    # The scratch repository is back on main, at the remote's main — not on the
    # proposal commit, which the next status would have read as pushed.
    repo = g.workspace_repo_getter(ws)
    assert _git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip() == "main"
    assert _git(repo, "rev-parse", "main") == _git(tmp_path / "remote.git", "rev-parse", "main")


async def test_a_failed_proposal_push_leaves_the_repository_on_its_base_branch(client, tmp_path, monkeypatch):
    headers = await _admin(client)
    ws, remote = await _linked_workspace(client, headers, tmp_path)
    await _push(client, headers, ws, {"wiki/home.md": "Hello\n"})
    real_run = g._run

    def failing_push(repo, *args, **kw):
        if args and args[0] == "push":
            raise g.GitError("rejected", "unknown")
        return real_run(repo, *args, **kw)

    monkeypatch.setattr(g, "_run", failing_push)
    with pytest.raises(g.GitError):
        await g.commit_push(
            g.workspace_repo_getter, ws, _zip({"wiki/home.md": "Proposed\n"}), "main", "m", remote, None,
            paths=["wiki/home.md"], push_branch="linkr/admin/x",
        )
    monkeypatch.setattr(g, "_run", real_run)
    repo = g.workspace_repo_getter(ws)
    assert _git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip() == "main"
    assert _git(repo, "rev-parse", "main") == _git(tmp_path / "remote.git", "rev-parse", "main")


async def test_relinking_to_a_new_empty_repository_pushes_everything_with_no_old_history(client, tmp_path):
    headers = await _admin(client)
    ws, first = await _linked_workspace(client, headers, tmp_path)
    files = {"wiki/home.md": "Hello\n", "workspace.json": "{}"}
    assert (await _push(client, headers, ws, files)).json()["pushed"]

    second = tmp_path / "second.git"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(second)], check=True, capture_output=True)
    await client.patch(f"{API}/workspaces/{ws}", headers=headers,
                       json={"gitRemoteConfig": {"url": f"file://{second}", "branch": "main"}})
    # Same content as the last commit on the old remote: it must still be pushed.
    r = await _push(client, headers, ws, files)
    assert r.json()["pushed"], r.text
    log = _git(second, "log", "--format=%s", "main").split()
    assert log == ["m"]  # one root commit, none of the first repository's
    assert _git(second, "show", "main:wiki/home.md") == "Hello\n"


async def test_a_workspace_in_review_mode_refuses_direct_pushes(client, tmp_path):
    headers = await _admin(client)
    ws, _ = await _linked_workspace(client, headers, tmp_path)
    r = await client.patch(f"{API}/workspaces/{ws}", headers=headers, json={"gitPushPolicy": "review"})
    assert r.status_code == 200 and r.json()["gitPushPolicy"] == "review"
    r = await _push(client, headers, ws, {"wiki/home.md": "Hello\n"})
    assert r.status_code == 403 and "review_required" in r.text


async def test_review_mode_refuses_a_direct_push_of_an_entity_in_the_workspace(client, tmp_path):
    headers = await _admin(client)
    ws, _ = await _linked_workspace(client, headers, tmp_path)
    await client.patch(f"{API}/workspaces/{ws}", headers=headers, json={"gitPushPolicy": "review"})
    remote = tmp_path / "project.git"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(remote)], check=True, capture_output=True)
    await client.post(f"{API}/projects", headers=headers, json={
        "workspaceId": ws, "uid": "p-review", "name": {"en": "P"},
        "gitRemoteConfig": {"url": f"file://{remote}", "branch": "main"},
    })
    r = await client.post(
        f"{API}/git/projects/p-review/commit-push", headers=headers,
        data={"message": "m", "branch": "main", "paths": ["README.md"]},
        files={"file": ("p.zip", _zip({"README.md": "x\n"}), "application/zip")},
    )
    assert r.status_code == 403 and "review_required" in r.text
