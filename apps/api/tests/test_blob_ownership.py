"""Naming a blob's hash does not give its content: the caller uploaded it too."""

import pytest

from app.api.v1.routes import dataset_files
from app.services import blob_store

API = "/api/v1"
pytestmark = pytest.mark.blob_ownership


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    token = (await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"}
    )).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def _upload(client, h: dict, data: bytes) -> str:
    upload = (await client.post(f"{API}/uploads", headers=h, json={"fileName": "x.csv", "totalChunks": 1})).json()
    uid = upload["uploadId"]
    assert (await client.put(f"{API}/uploads/{uid}/chunk", headers=h, params={"index": 0}, content=data)).status_code == 204
    return (await client.post(f"{API}/uploads/{uid}/complete", headers=h)).json()["sha"]


async def _project(client, h: dict) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=h, json={"workspaceId": ws, "name": {"en": "P"}})).json()["uid"]
    return ws, uid


async def test_a_blob_someone_else_put_there_cannot_be_read_by_its_hash(client, seed_roles):
    h = await _admin(client)
    _, uid = await _project(client, h)
    sha, _ = await blob_store.store_bytes(b"name\nsomeone-elses-row\n")
    r = await client.post(f"{API}/dataset-files/preview", headers=h, json={"projectUid": uid, "sha": sha, "fileName": "x.csv"})
    assert r.status_code == 400
    assert "someone-elses-row" not in r.text


async def test_a_blob_the_caller_uploaded_can_be_read(client, seed_roles):
    h = await _admin(client)
    _, uid = await _project(client, h)
    sha = await _upload(client, h, b"name\nown-row\n")
    r = await client.post(f"{API}/dataset-files/preview", headers=h, json={"projectUid": uid, "sha": sha, "fileName": "x.csv"})
    assert r.status_code == 200, r.text


async def test_a_blob_cannot_land_on_a_mapping_project_by_a_plain_update(client, seed_roles):
    h = await _admin(client)
    ws, _ = await _project(client, h)
    sha, _ = await blob_store.store_bytes(b"someone-elses-file")
    created = await client.post(
        f"{API}/mapping-projects", headers=h,
        json={"id": "mp1", "workspaceId": ws, "name": {"en": "M"}, "rawFileSha": sha},
    )
    assert created.status_code == 201
    assert created.json()["rawFileSha"] is None
    updated = await client.patch(f"{API}/mapping-projects/mp1", headers=h, json={"rawFileSha": sha, "scoresFileSha": sha})
    assert updated.status_code == 200
    assert updated.json()["rawFileSha"] is None
    assert updated.json()["scoresFileSha"] is None


async def test_an_import_landing_again_keeps_the_file_it_sent(client, seed_roles):
    h = await _admin(client)
    ws, _ = await _project(client, h)
    await client.post(f"{API}/mapping-projects", headers=h, json={"id": "mp1", "workspaceId": ws, "name": {"en": "M"}})
    sent = await client.post(f"{API}/mapping-projects/mp1/raw-file/append", headers=h, json={"text": "code\nA\n", "reset": True})
    assert sent.status_code == 200, sent.text
    sha = sent.json()["rawFileSha"]
    landed = await client.post(
        f"{API}/mapping-projects", headers=h,
        json={"id": "mp2", "workspaceId": ws, "name": {"en": "M"}, "rawFileSha": sha},
    )
    assert landed.json()["rawFileSha"] == sha


async def test_a_preview_names_what_it_read_in_the_access_log(client, seed_roles, monkeypatch):
    h = await _admin(client)
    _, uid = await _project(client, h)
    sha = await _upload(client, h, b"name\nown-row\n")
    bound = []
    monkeypatch.setattr(dataset_files.audit, "bind", lambda **fields: bound.append(fields))
    await client.post(f"{API}/dataset-files/preview", headers=h, json={"projectUid": uid, "sha": sha, "fileName": "x.csv"})
    assert any(f.get("action") == "preview" and "x.csv" in f.get("detail", "") for f in bound)
