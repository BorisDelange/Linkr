import hashlib

from app.services import blob_store

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _upload(client, headers, data: bytes, chunk_size: int, file_name="f.csv"):
    chunks = [data[i : i + chunk_size] for i in range(0, len(data), chunk_size)] or [b""]
    r = await client.post(
        f"{API}/uploads",
        headers=headers,
        json={"fileName": file_name, "totalChunks": len(chunks)},
    )
    uid = r.json()["uploadId"]
    return uid, chunks


async def test_chunked_upload_roundtrip(client):
    headers = await _admin_headers(client)
    data = b"patient,value\n" + b"\n".join(f"P{i},{i}".encode() for i in range(500))
    uid, chunks = await _upload(client, headers, data, 64)

    for i, ch in enumerate(chunks):
        r = await client.put(f"{API}/uploads/{uid}/chunk?index={i}", headers=headers, content=ch)
        assert r.status_code == 204

    r = await client.post(f"{API}/uploads/{uid}/complete", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["sha"] == hashlib.sha256(data).hexdigest()
    assert body["size"] == len(data)
    assert body["fileName"] == "f.csv"
    # Bytes are retrievable from the blob store.
    assert await blob_store.read_bytes(body["sha"]) == data


async def test_resume_reports_missing_chunks(client):
    headers = await _admin_headers(client)
    data = b"abcdefghij" * 100
    uid, chunks = await _upload(client, headers, data, 100)  # 10 chunks

    # Send all but chunk 3.
    for i, ch in enumerate(chunks):
        if i == 3:
            continue
        await client.put(f"{API}/uploads/{uid}/chunk?index={i}", headers=headers, content=ch)

    # Status reports chunk 3 missing; complete refuses.
    r = await client.get(f"{API}/uploads/{uid}", headers=headers)
    assert 3 not in r.json()["received"]
    r = await client.post(f"{API}/uploads/{uid}/complete", headers=headers)
    assert r.status_code == 409
    assert r.json()["detail"]["missing"] == [3]

    # Resume: send the missing chunk, then complete succeeds.
    await client.put(f"{API}/uploads/{uid}/chunk?index=3", headers=headers, content=chunks[3])
    r = await client.post(f"{API}/uploads/{uid}/complete", headers=headers)
    assert r.status_code == 200
    assert r.json()["sha"] == hashlib.sha256(data).hexdigest()


async def test_dedup_same_content(client):
    headers = await _admin_headers(client)
    data = b"identical bytes here"

    shas = []
    for _ in range(2):
        uid, chunks = await _upload(client, headers, data, 8)
        for i, ch in enumerate(chunks):
            await client.put(f"{API}/uploads/{uid}/chunk?index={i}", headers=headers, content=ch)
        r = await client.post(f"{API}/uploads/{uid}/complete", headers=headers)
        shas.append(r.json()["sha"])

    assert shas[0] == shas[1]  # same content → same sha (dedup)


async def test_upload_requires_auth(client):
    r = await client.post(f"{API}/uploads", json={"fileName": "x", "totalChunks": 1})
    assert r.status_code in (401, 403)


async def test_init_rejects_declared_oversize(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "max_upload_mb", 1)
    headers = await _admin_headers(client)
    r = await client.post(
        f"{API}/uploads",
        headers=headers,
        json={"fileName": "big.csv", "totalChunks": 1, "fileSize": 5 * 1024 * 1024},
    )
    assert r.status_code == 413


async def test_chunk_enforces_limit_when_size_understated(client, monkeypatch):
    """A client that lies about (or omits) fileSize is still cut off at the cap
    while streaming the chunk."""
    from app.config import settings

    monkeypatch.setattr(settings, "max_upload_mb", 1)
    headers = await _admin_headers(client)
    # Init without declaring fileSize → init guard can't catch it.
    uid = (await client.post(
        f"{API}/uploads", headers=headers, json={"fileName": "big.csv", "totalChunks": 1}
    )).json()["uploadId"]
    r = await client.put(
        f"{API}/uploads/{uid}/chunk?index=0", headers=headers, content=b"x" * (2 * 1024 * 1024)
    )
    assert r.status_code == 413
