from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _create_user(db, client, username: str) -> dict:
    db.add(User(username=username, password_hash=hash_password("pw"), role="user"))
    await db.commit()
    r = await client.post(
        f"{API}/auth/login", json={"username": username, "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _workspace(client, headers) -> str:
    return (
        await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})
    ).json()["id"]


async def _pipeline(client, headers, ws: str, pid="p1") -> dict:
    return (await client.post(f"{API}/etl-pipelines", headers=headers, json={
        "id": pid, "workspaceId": ws, "name": {"en": "ETL"}, "description": {},
        "sourceDataSourceId": "src-1",
    })).json()


async def test_pipeline_crud(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    assert p["workspaceId"] == ws and p["name"]["en"] == "ETL"
    assert p["status"] == "draft" and p["sourceDataSourceId"] == "src-1"

    listed = (await client.get(f"{API}/etl-pipelines?workspaceId={ws}", headers=headers)).json()
    assert [x["id"] for x in listed] == [p["id"]]

    r = await client.patch(f"{API}/etl-pipelines/{p['id']}", headers=headers,
                           json={"status": "ready", "targetDataSourceId": "tgt-1"})
    assert r.json()["status"] == "ready" and r.json()["targetDataSourceId"] == "tgt-1"

    assert (await client.delete(f"{API}/etl-pipelines/{p['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/etl-pipelines/{p['id']}", headers=headers)).status_code == 404


async def test_versioning_marks_round_trip(client):
    """Per-file versioning marks survive a PATCH and a re-read.

    They decide what the git export commits — a pipeline's data files hold a
    mapping dictionary that may be private — so losing them silently would
    publish rows the user marked as not-for-git."""
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    # Absent by default: an unmarked pipeline behaves exactly as before.
    assert p.get("config") is None

    config = {
        "versionedDataFiles": ["mapping/source_to_concept_map.csv"],
        "excludedFiles": ["scratch.sql"],
    }
    r = await client.patch(
        f"{API}/etl-pipelines/{p['id']}", headers=headers, json={"config": config}
    )
    assert r.status_code == 200
    assert r.json()["config"] == config

    reread = (await client.get(f"{API}/etl-pipelines/{p['id']}", headers=headers)).json()
    assert reread["config"] == config

    # An unrelated PATCH must not drop them (exclude_unset).
    await client.patch(f"{API}/etl-pipelines/{p['id']}", headers=headers, json={"status": "ready"})
    kept = (await client.get(f"{API}/etl-pipelines/{p['id']}", headers=headers)).json()
    assert kept["config"] == config


async def test_list_all_without_workspace_filter(client):
    # The store loads pipelines app-wide (no workspaceId) — must not 422.
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await _pipeline(client, headers, ws)
    r = await client.get(f"{API}/etl-pipelines", headers=headers)
    assert r.status_code == 200
    assert len(r.json()) == 1


async def test_file_tree_crud_and_cascade(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)

    folder = (await client.post(f"{API}/etl-files", headers=headers, json={
        "id": "f1", "pipelineId": p["id"], "name": "steps", "type": "folder", "order": 0,
    })).json()
    file = (await client.post(f"{API}/etl-files", headers=headers, json={
        "id": "f2", "pipelineId": p["id"], "name": "01_load.sql", "type": "file",
        "parentId": folder["id"], "content": "SELECT 1", "language": "sql", "order": 1,
        "disabled": False,
    })).json()
    assert file["parentId"] == "f1" and file["content"] == "SELECT 1"
    assert file["language"] == "sql" and file["disabled"] is False

    files = (await client.get(f"{API}/etl-pipelines/{p['id']}/files", headers=headers)).json()
    assert {f["id"] for f in files} == {"f1", "f2"}

    r = await client.patch(f"{API}/etl-files/{file['id']}", headers=headers,
                           json={"content": "SELECT 2", "disabled": True})
    assert r.json()["content"] == "SELECT 2" and r.json()["disabled"] is True

    # Deleting the pipeline cascades to its files.
    assert (await client.delete(f"{API}/etl-pipelines/{p['id']}", headers=headers)).status_code == 204
    p2 = await _pipeline(client, headers, ws, pid="p2")
    assert (await client.get(f"{API}/etl-pipelines/{p2['id']}/files", headers=headers)).json() == []


async def test_delete_files_for_pipeline(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    await client.post(f"{API}/etl-files", headers=headers, json={
        "id": "f1", "pipelineId": p["id"], "name": "a.sql", "type": "file", "order": 0,
    })
    assert (await client.delete(f"{API}/etl-pipelines/{p['id']}/files", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/etl-pipelines/{p['id']}/files", headers=headers)).json() == []


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    p = await _pipeline(client, admin, ws)

    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/etl-pipelines?workspaceId={ws}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/etl-pipelines/{p['id']}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/etl-pipelines/{p['id']}", headers=other)).status_code == 403
