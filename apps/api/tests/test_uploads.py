import hashlib

from app.services import blob_store

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"}
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


async def test_an_upload_session_belongs_to_its_uploader(client, db):
    # Sessions were not bound: any account holding an upload id could read its
    # progress, append chunks to it or complete it.
    from app.core.security import hash_password
    from app.models.user import User

    owner = await _admin_headers(client)
    db.add(User(username="bob", password_hash=hash_password("pw-for-tests-only"), role="user"))
    await db.commit()
    token = (await client.post(f"{API}/auth/login", json={"username": "bob", "password": "pw-for-tests-only"})).json()["access_token"]
    bob = {"Authorization": f"Bearer {token}"}
    uid, chunks = await _upload(client, owner, b"a,b\n1,2\n", 64)

    assert (await client.get(f"{API}/uploads/{uid}", headers=bob)).status_code == 404
    assert (await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=bob, content=b"x")).status_code == 404
    assert (await client.post(f"{API}/uploads/{uid}/complete", headers=bob)).status_code == 404

    for i, ch in enumerate(chunks):
        assert (await client.put(f"{API}/uploads/{uid}/chunk?index={i}", headers=owner, content=ch)).status_code == 204
    assert (await client.post(f"{API}/uploads/{uid}/complete", headers=owner)).status_code == 200


async def test_a_declared_chunk_count_stays_within_what_an_upload_can_hold(client):
    headers = await _admin_headers(client)
    for declared, expected in ((10**15, 413), (0, 400), (-1, 400)):
        r = await client.post(f"{API}/uploads", headers=headers, json={"fileName": "f.csv", "totalChunks": declared})
        assert r.status_code == expected, declared


async def test_a_file_name_stays_within_what_a_file_name_can_be(client):
    headers = await _admin_headers(client)
    r = await client.post(f"{API}/uploads", headers=headers, json={"fileName": "x" * 5000, "totalChunks": 1})
    assert r.status_code == 422


async def test_a_chunk_outside_the_declared_count_is_refused(client):
    headers = await _admin_headers(client)
    uid, _ = await _upload(client, headers, b"abcdefgh", 8)
    assert (await client.put(f"{API}/uploads/{uid}/chunk?index=1", headers=headers, content=b"x")).status_code == 400
    assert (await client.get(f"{API}/uploads/{uid}", headers=headers)).json()["received"] == []


async def test_completing_costs_what_was_stored_not_what_was_declared(client):
    # A session opened before the count was bounded may still be on disk.
    import json

    from app.api.v1.routes.uploads import MISSING_REPORTED
    from app.config import settings

    headers = await _admin_headers(client)
    uid, _ = await _upload(client, headers, b"abcdefgh", 8)
    declared = 2_000_000
    meta = settings.data_path / "_tmp" / uid / "_meta.json"
    meta.write_text(json.dumps({**json.loads(meta.read_text()), "totalChunks": declared}))
    await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=headers, content=b"x")

    r = await client.post(f"{API}/uploads/{uid}/complete", headers=headers)
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["missingCount"] == declared - 1
    assert detail["missing"][:2] == [1, 2] and len(detail["missing"]) == MISSING_REPORTED


GB = 1024 ** 3
MB = 1024 ** 2


def _free_space(monkeypatch, free: int):
    from app.api.v1.routes import uploads

    monkeypatch.setattr(uploads, "_free_bytes", lambda: free)


async def _member_headers(client, db, username: str) -> dict:
    from app.core.security import hash_password
    from app.models.user import User

    db.add(User(username=username, password_hash=hash_password("pw-for-tests-only"), role="user"))
    await db.commit()
    token = (await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_the_free_space_reserve_defaults_to_5_gb_and_the_quota_to_off(monkeypatch):
    from app.config import Settings

    monkeypatch.delenv("LINKR_UPLOAD_FREE_SPACE_RESERVE_MB", raising=False)
    monkeypatch.delenv("LINKR_UPLOAD_QUOTA_MB", raising=False)
    defaults = Settings(_env_file=None)
    assert defaults.upload_free_space_reserve_mb == 0
    assert defaults.upload_quota_mb == 0
    monkeypatch.setenv("LINKR_UPLOAD_QUOTA_MB", "7")
    monkeypatch.setenv("LINKR_UPLOAD_FREE_SPACE_RESERVE_MB", "9")
    assert Settings(_env_file=None).upload_quota_mb == 7
    assert Settings(_env_file=None).upload_free_space_reserve_mb == 9


async def test_an_upload_never_eats_into_the_free_space_reserve(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "upload_free_space_reserve_mb", 5120)
    headers = await _admin_headers(client)

    _free_space(monkeypatch, 5 * GB + 10 * MB)
    declared = await client.post(f"{API}/uploads", headers=headers, json={"fileName": "f", "totalChunks": 4, "fileSize": 20 * MB})
    assert declared.status_code == 507
    assert declared.json()["detail"]["code"] == "upload_no_space"
    assert declared.json()["detail"]["reserveMb"] == 5120

    uid = (await client.post(f"{API}/uploads", headers=headers, json={"fileName": "f", "totalChunks": 1})).json()["uploadId"]
    _free_space(monkeypatch, 5 * GB + 100)
    refused = await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=headers, content=b"x" * 200)
    assert refused.status_code == 507
    assert refused.json()["detail"]["code"] == "upload_no_space"
    assert (await client.get(f"{API}/uploads/{uid}", headers=headers)).json()["received"] == []
    assert not list((settings.data_path / "_tmp" / uid).glob("*.part"))

    _free_space(monkeypatch, 5 * GB + 1000)
    assert (await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=headers, content=b"x" * 200)).status_code == 204


async def test_completing_an_upload_needs_room_for_the_assembled_file(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "upload_free_space_reserve_mb", 5120)
    headers = await _admin_headers(client)
    _free_space(monkeypatch, 6 * GB)
    uid = (await client.post(f"{API}/uploads", headers=headers, json={"fileName": "f", "totalChunks": 1})).json()["uploadId"]
    assert (await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=headers, content=b"x" * 1000)).status_code == 204

    _free_space(monkeypatch, 5 * GB + 500)
    refused = await client.post(f"{API}/uploads/{uid}/complete", headers=headers)
    assert refused.status_code == 507
    assert (await client.get(f"{API}/uploads/{uid}", headers=headers)).json()["received"] == [0]

    _free_space(monkeypatch, 6 * GB)
    assert (await client.post(f"{API}/uploads/{uid}/complete", headers=headers)).status_code == 200


async def test_a_reserve_of_zero_turns_the_check_off(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "upload_free_space_reserve_mb", 0)
    _free_space(monkeypatch, 0)
    headers = await _admin_headers(client)
    uid, chunks = await _upload(client, headers, b"abc", 8)
    assert (await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=headers, content=chunks[0])).status_code == 204


async def test_chunks_arriving_together_are_counted_against_the_reserve(client, monkeypatch):
    from app.api.v1.routes import uploads
    from app.config import settings

    monkeypatch.setattr(settings, "upload_free_space_reserve_mb", 5120)
    _free_space(monkeypatch, 5 * GB + 1000)
    headers = await _admin_headers(client)
    uid = (await client.post(f"{API}/uploads", headers=headers, json={"fileName": "f", "totalChunks": 2})).json()["uploadId"]
    monkeypatch.setitem(uploads._incoming, object(), (-1, 900))
    refused = await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=headers, content=b"x" * 200)
    assert refused.status_code == 507
    assert (await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=headers, content=b"x" * 50)).status_code == 204


async def test_the_quota_is_off_by_default_and_counts_what_a_user_holds(client, db, monkeypatch):
    from app.config import settings

    headers = await _admin_headers(client)
    for payload in (b"first" * 100, b"second" * 100):
        uid, chunks = await _upload(client, headers, payload, 1000)
        assert (await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=headers, content=chunks[0])).status_code == 204
        assert (await client.post(f"{API}/uploads/{uid}/complete", headers=headers)).status_code == 200

    monkeypatch.setattr(settings, "upload_quota_mb", 1)
    bob = await _member_headers(client, db, "bob")
    held = b"b" * (600 * 1024)

    uid, chunks = await _upload(client, bob, held, len(held))
    assert (await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=bob, content=chunks[0])).status_code == 204
    assert (await client.post(f"{API}/uploads/{uid}/complete", headers=bob)).status_code == 200

    # Completed and not referenced yet: still on disk, still this user's.
    other = b"c" * (600 * 1024)
    uid, chunks = await _upload(client, bob, other, len(other))
    refused = await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=bob, content=chunks[0])
    assert refused.status_code == 413
    assert refused.json()["detail"]["code"] == "upload_quota_exceeded"
    assert refused.json()["detail"]["quotaMb"] == 1

    declared = await client.post(f"{API}/uploads", headers=bob, json={"fileName": "f", "totalChunks": 1, "fileSize": len(other)})
    assert declared.status_code == 413

    # One user's holdings never count against another.
    alice = await _member_headers(client, db, "alice")
    uid, chunks = await _upload(client, alice, other, len(other))
    assert (await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=alice, content=chunks[0])).status_code == 204

    # A blob gone from the store no longer counts.
    blob_store.path_for(hashlib.sha256(held).hexdigest()).unlink()
    uid, chunks = await _upload(client, bob, other, len(other))
    assert (await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=bob, content=chunks[0])).status_code == 204


async def test_a_chunk_the_client_abandons_leaves_no_partial_file(client, monkeypatch):
    from starlette.requests import ClientDisconnect

    from app.api.v1.routes import uploads
    from app.config import settings
    from app.models.user import User

    headers = await _admin_headers(client)
    uid = (await client.post(f"{API}/uploads", headers=headers, json={"fileName": "f", "totalChunks": 1})).json()["uploadId"]

    class Dropped:
        headers: dict = {}

        async def stream(self):
            yield b"partial"
            raise ClientDisconnect()

    monkeypatch.setattr(uploads, "_own_session", lambda *_: (settings.data_path / "_tmp" / uid, {"totalChunks": 1}))
    try:
        await uploads.put_chunk(uid, 0, Dropped(), User(id=1, username="admin"))
    except ClientDisconnect:
        pass
    assert not list((settings.data_path / "_tmp" / uid).glob("*.part"))
    assert not uploads._incoming


def test_the_api_says_at_boot_when_uploads_can_fill_the_data_volume(monkeypatch):
    from app.api.v1.routes import uploads
    from app.config import settings

    monkeypatch.setattr(settings, "upload_free_space_reserve_mb", 0)
    monkeypatch.setattr(settings, "upload_quota_mb", 0)
    assert uploads.limits_off()
    monkeypatch.setattr(settings, "upload_quota_mb", 1024)
    assert not uploads.limits_off()
    monkeypatch.setattr(settings, "upload_quota_mb", 0)
    monkeypatch.setattr(settings, "upload_free_space_reserve_mb", 5120)
    assert not uploads.limits_off()
