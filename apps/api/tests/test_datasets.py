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


async def _project(client, headers) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    return ws, uid


async def _upload_csv(client, headers, text: bytes) -> tuple[str, str]:
    r = await client.post(f"{API}/uploads", headers=headers, json={"fileName": "d.csv", "totalChunks": 1})
    uid = r.json()["uploadId"]
    await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=headers, content=text)
    r = await client.post(f"{API}/uploads/{uid}/complete", headers=headers)
    return r.json()["sha"], r.json()["fileName"]


async def test_import_dataset_end_to_end(client):
    headers = await _admin_headers(client)
    _, project_uid = await _project(client, headers)

    csv = b"patient,value,flag\nA,3.5,yes\nB,7,no\n"
    sha, file_name = await _upload_csv(client, headers, csv)

    r = await client.post(
        f"{API}/datasets/import",
        headers=headers,
        json={"projectUid": project_uid, "name": "My dataset", "sha": sha, "fileName": file_name},
    )
    assert r.status_code == 201
    ds = r.json()
    assert ds["rowCount"] == 2
    assert [c["type"] for c in ds["columns"]] == ["string", "number", "boolean"]
    assert "createdAt" in ds
    file_id = ds["id"]

    # Appears in the project listing.
    r = await client.get(f"{API}/datasets?projectUid={project_uid}", headers=headers)
    assert any(f["id"] == file_id for f in r.json())

    # Rows are keyed by columnId and coerced.
    r = await client.get(f"{API}/datasets/{file_id}/data", headers=headers)
    rows = r.json()["rows"]
    col_ids = [c["id"] for c in ds["columns"]]
    assert rows[0][col_ids[1]] == 3.5 and rows[0][col_ids[2]] is True

    # Delete.
    assert (await client.delete(f"{API}/datasets/{file_id}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/datasets/{file_id}", headers=headers)).status_code == 404


async def test_reimport_reparses_raw_file(client):
    headers = await _admin_headers(client)
    _, project_uid = await _project(client, headers)
    sha, fn = await _upload_csv(client, headers, b"a,b,c\n1,2,3\n4,5,6\n")
    ds = (await client.post(f"{API}/datasets/import", headers=headers,
          json={"projectUid": project_uid, "name": "d", "sha": sha, "fileName": fn})).json()
    assert [c["name"] for c in ds["columns"]] == ["a", "b", "c"]

    # Re-parse the stored raw file, skipping the header row so it becomes data.
    r = await client.post(f"{API}/datasets/{ds['id']}/reimport", headers=headers,
                          json={"parseOptions": {"hasHeader": False}})
    assert r.status_code == 200
    # No header → DuckDB auto-names columns; row count grows by the former header.
    assert r.json()["rowCount"] == 3


async def test_raw_file_downloadable_after_import(client):
    headers = await _admin_headers(client)
    _, project_uid = await _project(client, headers)
    csv = b"a,b\n1,2\n"
    sha, fn = await _upload_csv(client, headers, csv)
    ds = (await client.post(f"{API}/datasets/import", headers=headers,
          json={"projectUid": project_uid, "name": "d", "sha": sha, "fileName": fn})).json()

    r = await client.get(f"{API}/datasets/{ds['id']}/raw", headers=headers)
    assert r.status_code == 200
    assert r.content == csv
    assert r.headers["x-file-name"] == "d.csv"


async def test_write_and_read_rows(client):
    headers = await _admin_headers(client)
    _, project_uid = await _project(client, headers)
    # A file created without import (folder-style create then data write).
    ds = (await client.post(f"{API}/datasets", headers=headers,
          json={"projectUid": project_uid, "name": "manual", "type": "file"})).json()
    rows = [{"col-1-0": "x"}, {"col-1-0": "y"}]
    assert (await client.put(f"{API}/datasets/{ds['id']}/data", headers=headers,
            json={"rows": rows})).status_code == 204
    r = await client.get(f"{API}/datasets/{ds['id']}/data", headers=headers)
    assert r.json()["rows"] == rows


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    _, project_uid = await _project(client, admin)
    sha, fn = await _upload_csv(client, admin, b"a,b\n1,2\n")
    ds = (await client.post(f"{API}/datasets/import", headers=admin,
          json={"projectUid": project_uid, "name": "d", "sha": sha, "fileName": fn})).json()

    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/datasets?projectUid={project_uid}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/datasets/{ds['id']}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/datasets/{ds['id']}", headers=other)).status_code == 403


async def test_analyses_crud(client):
    headers = await _admin_headers(client)
    _, project_uid = await _project(client, headers)
    ds = (await client.post(f"{API}/datasets", headers=headers,
          json={"projectUid": project_uid, "name": "d", "type": "file"})).json()

    a = (await client.post(f"{API}/datasets/{ds['id']}/analyses", headers=headers,
         json={"datasetFileId": ds["id"], "name": "Table 1", "type": "table1", "config": {}})).json()
    assert a["type"] == "table1"
    r = await client.get(f"{API}/datasets/{ds['id']}/analyses", headers=headers)
    assert len(r.json()) == 1
    r = await client.patch(f"{API}/datasets/analyses/{a['id']}", headers=headers, json={"name": "T1"})
    assert r.json()["name"] == "T1"
    assert (await client.delete(f"{API}/datasets/analyses/{a['id']}", headers=headers)).status_code == 204
