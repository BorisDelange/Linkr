"""IDE code completion (POST /execute/complete): live-kernel and static paths."""

import shutil

import pytest

from app.services.execution import completion
from app.services.execution.completion import _r_items, _r_label

API = "/api/v1"

requires_r = pytest.mark.skipif(shutil.which("Rscript") is None, reason="Rscript not installed")


async def _setup(client) -> tuple[dict, str]:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    return headers, uid


async def _complete(client, headers, uid, code, language="python", cursor=None):
    r = await client.post(f"{API}/execute/complete", headers=headers, json={
        "language": language, "projectUid": uid, "code": code,
        "cursor": len(code) if cursor is None else cursor,
    })
    assert r.status_code == 200, r.text
    return r.json()


async def _run(client, headers, uid, code, language="python"):
    r = await client.post(f"{API}/execute", headers=headers,
                          json={"language": language, "code": code, "projectUid": uid})
    assert r.status_code == 200, r.text
    return r.json()


async def test_python_static_completion_without_a_kernel(client):
    headers, uid = await _setup(client)
    items = await _complete(client, headers, uid, "import os\nos.pa")
    labels = [i["label"] for i in items]
    assert "path" in labels
    path = next(i for i in items if i["label"] == "path")
    assert path["typed"] == 2 and path["insert"] == "path"


async def test_static_completion_does_not_see_the_apis_own_environment(client):
    headers, uid = await _setup(client)
    assert await _complete(client, headers, uid, "import app.") == []
    assert await _complete(client, headers, uid, "from app.services import ") == []
    assert await _complete(client, headers, uid, "import fasta") == []
    assert "json" in [i["label"] for i in await _complete(client, headers, uid, "import jso")]


async def test_static_completion_returns_nothing_while_a_call_is_running():
    assert completion._static_lock.acquire(blocking=False)
    try:
        assert await completion.complete(None, "python", "import os\nos.pa", 15) == []
    finally:
        completion._static_lock.release()
    assert "path" in [i["label"] for i in await completion.complete(None, "python", "import os\nos.pa", 15)]


async def test_completion_bounds_its_input(client):
    headers, uid = await _setup(client)
    for body in ({"code": "x" * 200_001, "cursor": 0}, {"code": "x", "cursor": -1}):
        r = await client.post(f"{API}/execute/complete", headers=headers,
                              json={"language": "python", "projectUid": uid, **body})
        assert r.status_code == 422


async def test_python_completion_sees_the_session_variables(client):
    headers, uid = await _setup(client)
    await _run(client, headers, uid, "class Box:\n    def __init__(self):\n        self.weight_kg = 1\nbox = Box()")
    # The editor's text alone cannot know `box` — only the live namespace does.
    items = await _complete(client, headers, uid, "box.wei")
    assert [i["label"] for i in items] == ["weight_kg"]


async def test_completion_does_not_desync_the_next_run(client):
    headers, uid = await _setup(client)
    await _run(client, headers, uid, "x = 1")
    for _ in range(3):
        await _complete(client, headers, uid, "x.")
    out = await _run(client, headers, uid, "print(x + 1)")
    assert out["stdout"].strip() == "2"


@requires_r
async def test_r_completion_lists_data_frame_columns(client):
    headers, uid = await _setup(client)
    await _run(client, headers, uid, "patients <- data.frame(age_years = 1, sex = 'F')", language="r")
    items = await _complete(client, headers, uid, "summary(1)\npatients$ag", language="r")
    assert [(i["label"], i["insert"], i["typed"]) for i in items] == [("age_years", "patients$age_years", 11)]
    out = await _run(client, headers, uid, "cat(nrow(patients))", language="r")
    assert out["stdout"].strip() == "1"


async def test_r_without_a_kernel_returns_nothing(client):
    headers, uid = await _setup(client)
    assert await _complete(client, headers, uid, "pati", language="r") == []


async def test_completion_requires_execute_permission(client):
    _, uid = await _setup(client)
    r = await client.post(f"{API}/execute/complete", json={"language": "python", "projectUid": uid, "code": "", "cursor": 0})
    assert r.status_code == 401


def test_r_items_label_drops_the_accessor_and_keeps_scalars():
    assert _r_label("df$col") == "col"
    assert _r_label("stats::median") == "median"
    assert _r_label("pkg:::hidden") == "hidden"
    assert _r_label("mean") == "mean"
    # jsonlite unboxes a one-element vector unless I() is used — accept both.
    assert _r_items({"token": "me", "completions": "mean("}) == [
        {"label": "mean(", "insert": "mean(", "kind": "function", "typed": 2}
    ]
