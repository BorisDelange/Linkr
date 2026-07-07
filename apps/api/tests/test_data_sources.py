from app.core.security import hash_password
from app.models.user import User
from app.services import blob_store
from app.services.data_source_service import strip_secrets

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


async def _upload(client, headers, data: bytes, name: str = "vocab.parquet") -> str:
    r = await client.post(
        f"{API}/uploads", headers=headers, json={"fileName": name, "totalChunks": 1}
    )
    uid = r.json()["uploadId"]
    await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=headers, content=data)
    return (await client.post(f"{API}/uploads/{uid}/complete", headers=headers)).json()["sha"]


def test_strip_secrets_removes_password_and_token():
    assert strip_secrets(
        {"engine": "postgresql", "host": "localhost", "password": "s3cr3t", "token": "t"}
    ) == {"engine": "postgresql", "host": "localhost"}
    assert strip_secrets(None) == {}


async def test_create_strips_password(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    body = {
        "workspaceId": ws,
        "alias": "pg",
        "name": "Local Postgres",
        "sourceType": "database",
        "connectionConfig": {
            "engine": "postgresql",
            "host": "localhost",
            "port": 5432,
            "database": "linkr",
            "username": "boris",
            "password": "s3cr3t",
        },
    }
    r = await client.post(f"{API}/data-sources", headers=headers, json=body)
    assert r.status_code == 201
    ds = r.json()
    # The password never round-trips — it was stripped before persistence.
    assert "password" not in ds["connectionConfig"]
    assert ds["connectionConfig"]["host"] == "localhost"

    fetched = (await client.get(f"{API}/data-sources/{ds['id']}", headers=headers)).json()
    assert "password" not in fetched["connectionConfig"]


async def test_update_strips_password(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "pg", "name": "PG", "sourceType": "database",
        "connectionConfig": {"engine": "postgresql", "host": "a"},
    })).json()
    r = await client.patch(f"{API}/data-sources/{ds['id']}", headers=headers, json={
        "connectionConfig": {"engine": "postgresql", "host": "b", "password": "leak"},
    })
    assert r.status_code == 200
    assert "password" not in r.json()["connectionConfig"]
    assert r.json()["connectionConfig"]["host"] == "b"


async def test_list_by_workspace(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "a", "name": "A", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })
    r = await client.get(f"{API}/data-sources?workspaceId={ws}", headers=headers)
    assert r.status_code == 200 and len(r.json()) == 1


async def test_file_import_dedup_and_cascade(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)

    async def _source(alias):
        return (await client.post(f"{API}/data-sources", headers=headers, json={
            "workspaceId": ws, "alias": alias, "name": alias, "sourceType": "database",
            "connectionConfig": {"engine": "duckdb"},
        })).json()["id"]

    src_a, src_b = await _source("a"), await _source("b")

    # The same bytes imported into two sources share one blob (dedup by sha).
    payload = b"PAR1_fake_parquet_bytes"
    sha = await _upload(client, headers, payload)
    fa = (await client.post(f"{API}/data-sources/files/import", headers=headers, json={
        "dataSourceId": src_a, "sha": sha, "fileName": "vocab.parquet", "fileSize": len(payload),
    })).json()
    fb = (await client.post(f"{API}/data-sources/files/import", headers=headers, json={
        "dataSourceId": src_b, "sha": sha, "fileName": "vocab.parquet", "fileSize": len(payload),
    })).json()
    assert fa["contentHash"] == fb["contentHash"] == sha
    assert blob_store.exists(sha)

    # Bytes are downloadable for the browser DuckDB mount path.
    r = await client.get(f"{API}/data-sources/files/{fa['id']}/blob", headers=headers)
    assert r.status_code == 200 and r.content == payload
    assert r.headers["x-file-name"] == "vocab.parquet"

    # Deleting source A must NOT free the blob — source B still references it.
    assert (await client.delete(f"{API}/data-sources/{src_a}", headers=headers)).status_code == 204
    assert blob_store.exists(sha)

    # Deleting the last referencing source frees the blob.
    assert (await client.delete(f"{API}/data-sources/{src_b}", headers=headers)).status_code == 204
    assert not blob_store.exists(sha)


async def test_files_listed_and_deletable(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "a", "name": "A", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })).json()["id"]
    sha = await _upload(client, headers, b"bytes-1", name="f1.parquet")
    f = (await client.post(f"{API}/data-sources/files/import", headers=headers, json={
        "dataSourceId": src, "sha": sha, "fileName": "f1.parquet", "fileSize": 7,
    })).json()

    listed = (await client.get(f"{API}/data-sources/{src}/files", headers=headers)).json()
    assert [x["id"] for x in listed] == [f["id"]]

    assert (await client.delete(f"{API}/data-sources/files/{f['id']}", headers=headers)).status_code == 204
    assert not blob_store.exists(sha)  # last reference gone


async def test_import_missing_blob_is_400(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "a", "name": "A", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/files/import", headers=headers, json={
        "dataSourceId": src, "sha": "0" * 64, "fileName": "x.parquet", "fileSize": 1,
    })
    assert r.status_code == 400


async def test_test_connection_unsupported_engine(client):
    headers = await _admin_headers(client)
    r = await client.post(f"{API}/data-sources/test-connection", headers=headers, json={
        "connectionConfig": {"engine": "duckdb"},
    })
    assert r.status_code == 200
    assert r.json()["ok"] is False and "unsupported" in r.json()["error"]


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    ds = (await client.post(f"{API}/data-sources", headers=admin, json={
        "workspaceId": ws, "alias": "a", "name": "A", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })).json()

    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/data-sources?workspaceId={ws}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/data-sources/{ds['id']}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/data-sources/{ds['id']}", headers=other)).status_code == 403
    # A workspace-filtered list they can't see returns 403; unfiltered omits it.
    assert (await client.get(f"{API}/data-sources", headers=other)).json() == []
