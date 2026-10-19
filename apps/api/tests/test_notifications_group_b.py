from app.services import notification_hub
from tests.test_mapping_projects import API, _admin_headers, _project, _workspace

MCP = {"X-Linkr-Client": "mcp"}


async def _list(client, headers) -> list[dict]:
    return (await client.get(f"{API}/notifications", headers=headers)).json()


def _mapping(mid: str, code: str, pid="mp1") -> dict:
    return {
        "id": mid, "projectId": pid, "sourceVocabularyId": "LOCAL", "sourceConceptCode": code,
        "sourceConceptName": f"Concept {code}", "targetConceptId": 3000 + int(code),
        "targetConceptName": "Target", "equivalence": "skos:exactMatch", "status": "unchecked",
        "comments": [{"text": "first"}],
    }


async def test_mapping_project_lifecycle_by_an_agent_is_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    await _project(client, headers, ws)
    assert await _list(client, headers) == []

    await _project(client, agent, ws, pid="mp2")
    [created] = await _list(client, headers)
    assert (created["action"], created["entityType"], created["entityId"]) == ("created", "mapping_project", "mp2")
    assert created["projectUid"] is None and created["detail"] == {"workspaceId": ws}

    await client.patch(f"{API}/mapping-projects/mp2", headers=agent, json={"name": {"en": "Renamed"}})
    renamed = (await _list(client, headers))[0]
    assert renamed["action"] == "updated" and renamed["label"] == {"en": "Renamed"} and not renamed["undoable"]

    # The same name again, or only the stats a mapping write recomputes: the
    # open tab refreshes, the bell stays quiet.
    queue = notification_hub.subscribe(1)
    try:
        await client.patch(f"{API}/mapping-projects/mp2", headers=agent, json={"name": {"en": "Renamed"}})
        assert queue.empty()
        await client.patch(f"{API}/mapping-projects/mp2", headers=agent, json={"stats": {"mappedCount": 3}})
        event = queue.get_nowait()
        assert (event["entityType"], event["entityId"]) == ("mapping_project", "mp2") and "notification" not in event
        # Deleting a project's mappings is the first half of deleting it.
        await client.delete(f"{API}/mapping-projects/mp2/mappings", headers=agent)
        assert "notification" not in queue.get_nowait()
    finally:
        notification_hub.unsubscribe(1, queue)
    assert len(await _list(client, headers)) == 2

    await client.delete(f"{API}/mapping-projects/mp2", headers=agent)
    deleted = (await _list(client, headers))[0]
    assert deleted["action"] == "deleted" and deleted["label"] == {"en": "Renamed"}


async def test_single_mapping_writes_are_notified_with_their_item(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    await _project(client, headers, ws)
    await client.post(f"{API}/concept-mappings/batch", headers=headers, json={"mappings": [_mapping("m1", "1")]})
    await client.patch(f"{API}/concept-mappings/m1", headers=headers, json={"equivalence": "skos:closeMatch"})
    assert await _list(client, headers) == []

    await client.patch(f"{API}/concept-mappings/m1", headers=agent, json={"equivalence": "skos:closeMatch"})
    assert await _list(client, headers) == []

    comments = [{"text": "first"}, {"text": "checked"}]
    await client.patch(f"{API}/concept-mappings/m1", headers=agent, json={"comments": comments})
    [updated] = await _list(client, headers)
    assert updated["entityId"] == "mp1" and updated["label"] == {"en": "Mapping"}
    detail = updated["detail"]
    assert {k: detail[k] for k in ("workspaceId", "part", "action", "count", "more")} == {
        "workspaceId": ws, "part": "mappings", "action": "updated", "count": 1, "more": 0,
    }
    assert detail["items"][0]["sourceCode"] == "1" and detail["items"][0]["comment"] == "checked"

    await client.delete(f"{API}/concept-mappings/m1", headers=agent)
    deleted = (await _list(client, headers))[0]
    assert deleted["detail"]["action"] == "deleted" and deleted["detail"]["items"][0]["conceptId"] == 3001


async def test_batch_review_and_delete_notify_once(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    await _project(client, headers, ws)
    batch = [_mapping(f"m{i}", str(i)) for i in range(1, 4)]
    await client.post(f"{API}/concept-mappings/batch", headers=headers, json={"mappings": batch})

    vote = {"reviews": [{"reviewerId": "admin", "status": "approved"}], "reviewedBy": "admin"}
    r = await client.post(f"{API}/concept-mappings/batch-update", headers=agent, json={
        "mappings": [{"id": "m1", **vote}, {"id": "m2", **vote}, {"id": "m3", "equivalence": "skos:exactMatch"}],
    })
    assert r.status_code == 204
    [reviewed] = await _list(client, headers)
    # m3 was sent unchanged: not counted.
    assert reviewed["detail"]["action"] == "updated" and reviewed["detail"]["count"] == 2
    mappings = (await client.get(f"{API}/mapping-projects/mp1/mappings", headers=headers)).json()
    assert {m["id"]: m["reviewedBy"] for m in mappings} == {"m1": "admin", "m2": "admin", "m3": None}

    r = await client.post(f"{API}/concept-mappings/batch-delete", headers=agent, json={"ids": ["m1", "m2", "m2"]})
    assert r.status_code == 204
    deleted = (await _list(client, headers))[0]
    assert deleted["detail"]["action"] == "deleted" and deleted["detail"]["count"] == 2
    assert len(await _list(client, headers)) == 2
    assert [m["id"] for m in (await client.get(f"{API}/mapping-projects/mp1/mappings", headers=headers)).json()] == ["m3"]

    missing = await client.post(f"{API}/concept-mappings/batch-delete", headers=agent, json={"ids": ["m3", "nope"]})
    assert missing.status_code == 404
    assert len((await client.get(f"{API}/mapping-projects/mp1/mappings", headers=headers)).json()) == 1


async def test_source_concept_ids_by_an_agent_are_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    rng = {"workspaceId": ws, "badgeLabel": "Rennes", "rangeStart": 2_000_000_000, "rangeEnd": 2_000_999_999,
           "nextId": 2_000_000_000, "createdAt": "2026-10-18T10:00:00Z", "updatedAt": "2026-10-18T10:00:00Z"}
    await client.put(f"{API}/source-concept-id-ranges", headers=headers, json=rng)
    assert await _list(client, headers) == []

    await client.put(f"{API}/source-concept-id-ranges", headers=agent, json={**rng, "rangeEnd": 2_001_999_999})
    [moved] = await _list(client, headers)
    assert (moved["entityType"], moved["entityId"], moved["label"]) == ("source_concept_ids", "Rennes", {"en": "Rennes"})
    assert moved["detail"] == {
        "workspaceId": ws, "part": "range", "action": "updated", "name": "2000000000–2001999999",
    }

    entries = [{"id": f"e{i}", "workspaceId": ws, "badgeLabel": "Rennes", "vocabularyId": "LOCAL",
                "conceptCode": str(i), "sourceConceptId": 2_000_000_000 + i} for i in range(3)]
    queue = notification_hub.subscribe(1)
    try:
        await client.put(f"{API}/source-concept-id-entries/batch", headers=agent, json={"entries": entries})
        assert queue.get_nowait()["notification"]["detail"] == {
            "workspaceId": ws, "part": "entries", "action": "created", "name": "2000000000–2000000002", "count": 3,
        }
        # The cursor an assignment moves after each chunk: refresh only.
        cursor = {**rng, "rangeEnd": 2_001_999_999, "nextId": 2_000_000_003, "totalConcepts": 3,
                  "updatedAt": "2026-10-18T10:05:00Z"}
        await client.put(f"{API}/source-concept-id-ranges", headers=agent, json=cursor)
        assert "notification" not in queue.get_nowait()
    finally:
        notification_hub.unsubscribe(1, queue)
    assert len(await _list(client, headers)) == 2


async def test_schema_preset_saves_by_an_agent_are_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    mapping = {"formatVersion": 2, "presetId": "p", "presetLabel": {"en": "My schema"},
               "events": [{"label": "Heart rate", "from": {"table": "vitals", "alias": "v"}}]}
    preset = {"id": "sp1", "presetId": "sp1", "entityId": "my-schema", "workspaceId": ws, "mapping": mapping}
    await client.put(f"{API}/schema-presets/sp1", headers=headers, json=preset)
    assert await _list(client, headers) == []

    await client.put(f"{API}/schema-presets/sp2", headers=agent, json={**preset, "id": "sp2", "presetId": "sp2"})
    [created] = await _list(client, headers)
    assert (created["action"], created["entityType"], created["entityId"]) == ("created", "schema_preset", "sp2")
    assert created["label"] == {"en": "My schema"} and created["detail"] == {"workspaceId": ws}

    # Saved back as read: nothing changed.
    await client.put(f"{API}/schema-presets/sp1", headers=agent, json=preset)
    assert len(await _list(client, headers)) == 1

    edited = {**mapping, "events": [{**mapping["events"][0], "where": "v.valid"}]}
    await client.put(f"{API}/schema-presets/sp1", headers=agent, json={**preset, "mapping": edited})
    updated = (await _list(client, headers))[0]
    assert updated["detail"] == {
        "workspaceId": ws, "part": "relation", "action": "updated", "name": "events.Heart rate", "count": 1,
    }

    removed = {**edited, "events": []}
    await client.put(f"{API}/schema-presets/sp1", headers=agent, json={**preset, "mapping": removed})
    assert (await _list(client, headers))[0]["detail"]["action"] == "deleted"

    await client.put(f"{API}/schema-presets/sp1", headers=agent, json={**preset, "mapping": removed, "version": "0.2.0"})
    assert (await _list(client, headers))[0]["detail"] == {"workspaceId": ws}
