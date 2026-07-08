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


async def test_range_upsert_and_delete(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)

    # Save (insert)
    r = await client.put(f"{API}/source-concept-id-ranges", headers=headers, json={
        "workspaceId": ws, "badgeLabel": "Rennes",
        "rangeStart": 2_000_000_001, "rangeEnd": 2_000_100_000, "nextId": 2_000_000_001,
    })
    assert r.json()["rangeStart"] == 2_000_000_001 and r.json()["nextId"] == 2_000_000_001

    # Save (update same composite key) — must not duplicate
    await client.put(f"{API}/source-concept-id-ranges", headers=headers, json={
        "workspaceId": ws, "badgeLabel": "Rennes",
        "rangeStart": 2_000_000_001, "rangeEnd": 2_000_100_000, "nextId": 2_000_000_050,
        "totalConcepts": 49,
    })
    listed = (await client.get(f"{API}/source-concept-id-ranges?workspaceId={ws}", headers=headers)).json()
    assert len(listed) == 1 and listed[0]["nextId"] == 2_000_000_050 and listed[0]["totalConcepts"] == 49

    got = (await client.get(f"{API}/source-concept-id-ranges/{ws}/Rennes", headers=headers)).json()
    assert got["badgeLabel"] == "Rennes"

    assert (await client.delete(f"{API}/source-concept-id-ranges/{ws}/Rennes", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/source-concept-id-ranges?workspaceId={ws}", headers=headers)).json() == []


async def test_entry_batch_and_delete_by_badge(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)

    entries = [
        {"id": f"{ws}__Rennes__LOINC__{code}", "workspaceId": ws, "badgeLabel": "Rennes",
         "vocabularyId": "LOINC", "conceptCode": code, "sourceConceptId": 2_000_000_000 + i}
        for i, code in enumerate(["1234-5", "6789-0"])
    ]
    entries.append({"id": f"{ws}__Nantes__LOINC__9999", "workspaceId": ws, "badgeLabel": "Nantes",
                    "vocabularyId": "LOINC", "conceptCode": "9999", "sourceConceptId": 2_000_000_099})

    assert (await client.put(f"{API}/source-concept-id-entries/batch", headers=headers,
                             json={"entries": entries})).status_code == 204

    rennes = (await client.get(f"{API}/source-concept-id-entries?workspaceId={ws}&badgeLabel=Rennes", headers=headers)).json()
    assert len(rennes) == 2
    all_entries = (await client.get(f"{API}/source-concept-id-entries?workspaceId={ws}", headers=headers)).json()
    assert len(all_entries) == 3

    # Upsert one entry (same id) — no duplicate
    await client.put(f"{API}/source-concept-id-entries", headers=headers, json={
        **entries[0], "sourceConceptId": 2_000_000_500,
    })
    rennes2 = (await client.get(f"{API}/source-concept-id-entries?workspaceId={ws}&badgeLabel=Rennes", headers=headers)).json()
    assert len(rennes2) == 2
    assert next(e for e in rennes2 if e["id"] == entries[0]["id"])["sourceConceptId"] == 2_000_000_500

    # Delete by badge
    assert (await client.delete(f"{API}/source-concept-id-entries?workspaceId={ws}&badgeLabel=Rennes", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/source-concept-id-entries?workspaceId={ws}", headers=headers)).json() != []
    assert (await client.get(f"{API}/source-concept-id-entries?workspaceId={ws}&badgeLabel=Rennes", headers=headers)).json() == []


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    await client.put(f"{API}/source-concept-id-ranges", headers=admin, json={
        "workspaceId": ws, "badgeLabel": "Rennes",
        "rangeStart": 2_000_000_001, "rangeEnd": 2_000_100_000, "nextId": 2_000_000_001,
    })
    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/source-concept-id-ranges?workspaceId={ws}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/source-concept-id-entries?workspaceId={ws}", headers=other)).status_code == 403
