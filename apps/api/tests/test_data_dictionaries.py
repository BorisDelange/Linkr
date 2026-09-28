"""Data dictionaries: a sync keeps a set's id when it changes, so the projects
that use it keep it."""

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _set(uid: str, version: str, name: str = "Heart rate") -> dict:
    return {
        "name": name, "uniqueId": uid, "version": version, "sourceRepo": "https://github.com/indicate-eu/data-dictionary",
        "sourceUrl": f"concept_sets/{uid}.json",
        "expression": {"items": [{"concept": {"conceptId": 3027018}, "isExcluded": False, "includeDescendants": True, "includeMapped": False}]},
    }


async def test_sync_adds_updates_in_place_and_removes(client):
    headers = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    d = (await client.post(f"{API}/data-dictionaries", headers=headers, json={
        "id": "d1", "workspaceId": ws, "name": "INDICATE", "sourceRepo": "https://github.com/indicate-eu/data-dictionary",
    })).json()
    content = f"{API}/data-dictionaries/{d['id']}/content"
    units = [{"conceptId": 1, "sourceUnitConceptId": 8636, "targetUnitConceptId": 8753, "conversionFactor": 5.55}]

    r = await client.put(content, headers=headers, json={
        "conceptSets": [_set("a", "1.0.0"), _set("b", "1.0.0")], "unitConversions": units, "commit": "c1"})
    assert r.json() == {"added": 2, "updated": 0, "removed": 0, "unchanged": 0}
    sets = (await client.get(f"{API}/concept-sets?workspaceId={ws}", headers=headers)).json()
    ids = {s["uniqueId"]: s["id"] for s in sets}
    assert all(s["dictionaryId"] == "d1" for s in sets)

    r = await client.put(content, headers=headers, json={
        "conceptSets": [_set("a", "1.1.0", "Heart rate (v2)"), _set("c", "1.0.0")], "commit": "c2"})
    assert r.json() == {"added": 1, "updated": 1, "removed": 1, "unchanged": 0}
    sets = {s["uniqueId"]: s for s in (await client.get(f"{API}/concept-sets?workspaceId={ws}", headers=headers)).json()}
    assert sorted(sets) == ["a", "c"]
    assert sets["a"]["id"] == ids["a"] and sets["a"]["version"] == "1.1.0"

    listed = (await client.get(f"{API}/data-dictionaries?workspaceId={ws}", headers=headers)).json()
    assert listed[0]["commit"] == "c2" and listed[0]["unitConversions"] is None and listed[0]["syncedAt"]

    assert (await client.delete(f"{API}/data-dictionaries/d1", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/concept-sets?workspaceId={ws}", headers=headers)).json() == []


async def _dictionary(client, headers) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    d = (await client.post(f"{API}/data-dictionaries", headers=headers, json={"id": "d1", "workspaceId": ws, "name": "D"})).json()
    return ws, f"{API}/data-dictionaries/{d['id']}/content"


async def test_sync_leaves_a_keyless_set_alone(client):
    # The front plan, which the user previews, never lists a set with neither
    # uniqueId nor sourceUrl: the server apply must not delete it either.
    headers = await _admin_headers(client)
    ws, content = await _dictionary(client, headers)
    r = await client.post(f"{API}/concept-sets", headers=headers, json={
        "id": "keyless", "workspaceId": ws, "name": "Hand-made", "dictionaryId": "d1"})
    assert r.status_code in (200, 201)

    r = await client.put(content, headers=headers, json={"conceptSets": [_set("a", "1.0.0")], "commit": "c1"})
    assert r.json() == {"added": 1, "updated": 0, "removed": 0, "unchanged": 0}
    ids = {s["id"] for s in (await client.get(f"{API}/concept-sets?workspaceId={ws}", headers=headers)).json()}
    assert "keyless" in ids


async def test_sync_drops_unit_rows_whose_numbers_are_not_numbers(client):
    headers = await _admin_headers(client)
    ws, content = await _dictionary(client, headers)
    units = [
        {"conceptId": 1, "sourceUnitConceptId": 8840, "targetUnitConceptId": 8753, "conversionFactor": "1; DROP TABLE measurement; --"},
        {"conceptId": 1, "sourceUnitConceptId": "8876) OR 1=1 --", "targetUnitConceptId": 8753, "conversionFactor": 2},
        {"conceptId": 1, "sourceUnitConceptId": 8713, "targetUnitConceptId": 8753, "conversionFactor": 0.5, "offset": "x"},
        {"conceptId": 1, "sourceUnitConceptId": 8636, "targetUnitConceptId": "8753", "conversionFactor": "5.55", "sourceUnitCode": "mmol/L"},
    ]
    recommended = [{"conceptId": 1, "recommendedUnitConceptId": "nope"}, {"conceptId": 1, "recommendedUnitConceptId": 8753}]
    await client.put(content, headers=headers, json={
        "conceptSets": [_set("a", "1.0.0")], "unitConversions": units, "recommendedUnits": recommended})
    listed = (await client.get(f"{API}/data-dictionaries?workspaceId={ws}", headers=headers)).json()[0]
    assert listed["unitConversions"] == [
        {"conceptId": 1, "sourceUnitConceptId": 8636, "targetUnitConceptId": 8753, "conversionFactor": 5.55, "sourceUnitCode": "mmol/L"},
    ]
    assert listed["recommendedUnits"] == [{"conceptId": 1, "recommendedUnitConceptId": 8753}]
