import json

from app.services import notification_hub
from tests.test_notifications import MCP, _list
from tests.test_sql_scripts import API, _admin_headers, _collection, _workspace


async def test_sql_collection_writes_by_an_agent_are_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    await _collection(client, headers, ws)
    folder = {"id": "f0", "collectionId": "c1", "name": "cohorts", "type": "folder"}
    await client.post(f"{API}/sql-script-files", headers=headers, json=folder)
    assert await _list(client, headers) == []

    script = {"id": "f1", "collectionId": "c1", "name": "adults.sql", "parentId": "f0", "content": "SELECT 1"}
    assert (await client.post(f"{API}/sql-script-files", headers=agent, json=script)).status_code == 201
    await client.patch(f"{API}/sql-script-files/f1", headers=agent, json={"content": "SELECT 2"})
    updated, created = await _list(client, headers)
    assert (created["entityType"], created["entityId"], created["label"]) == ("sql_collection", "c1", {"en": "Queries"})
    assert created["projectUid"] is None
    assert created["detail"] == {
        "workspaceId": ws, "part": "script", "action": "created", "name": "cohorts/adults.sql", "fileId": "f1",
    }
    assert updated["detail"]["action"] == "updated" and not updated["undoable"]

    queue = notification_hub.subscribe(1)
    try:
        await client.patch(f"{API}/sql-script-files/f1", headers=agent, json={"content": "SELECT 2"})
        assert queue.empty()
        await client.patch(f"{API}/sql-script-files/f1", headers=agent, json={"order": 5})
        await client.patch(f"{API}/sql-script-collections/c1", headers=agent, json={"config": {"excludedFiles": []}})
        refreshes = [queue.get_nowait(), queue.get_nowait()]
        assert all("notification" not in e and e["entityType"] == "sql_collection" for e in refreshes)
    finally:
        notification_hub.unsubscribe(1, queue)
    assert len(await _list(client, headers)) == 2

    await client.delete(f"{API}/sql-script-files/f0", headers=agent)
    deleted = (await _list(client, headers))[0]
    assert deleted["detail"] == {"workspaceId": ws, "part": "folder", "action": "deleted", "name": "cohorts", "fileId": "f0"}

    await client.patch(f"{API}/sql-script-collections/c1", headers=agent, json={"name": {"en": "Renamed"}})
    renamed = (await _list(client, headers))[0]
    assert renamed["label"] == {"en": "Renamed"} and renamed["detail"] == {"workspaceId": ws}

    await client.delete(f"{API}/sql-script-collections/c1/files", headers=agent)
    assert len(await _list(client, headers)) == 4
    await client.delete(f"{API}/sql-script-collections/c1", headers=agent)
    assert (await _list(client, headers))[0]["action"] == "deleted"


async def test_wiki_page_writes_by_an_agent_are_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    page = {"id": "w1", "workspaceId": ws, "title": {"en": "Guide"}, "content": {"en": "hi"}}
    await client.post(f"{API}/wiki-pages", headers=headers, json=page)
    assert await _list(client, headers) == []

    await client.post(f"{API}/wiki-pages", headers=agent, json={**page, "id": "w2", "title": {"en": "FAQ"}})
    [created] = await _list(client, headers)
    assert (created["action"], created["entityType"], created["entityId"]) == ("created", "wiki_page", "w2")
    assert created["label"] == {"en": "FAQ"} and created["detail"] == {"workspaceId": ws}
    assert created["projectUid"] is None

    await client.patch(f"{API}/wiki-pages/w1", headers=agent, json={"title": {"en": "Guide"}})
    await client.patch(f"{API}/wiki-pages/w1", headers=agent, json={"sortOrder": 3})
    assert len(await _list(client, headers)) == 1

    await client.patch(f"{API}/wiki-pages/w1", headers=agent, json={"parentId": "w2"})
    moved = (await _list(client, headers))[0]
    assert (moved["action"], moved["entityId"], moved["label"]) == ("updated", "w1", {"en": "Guide"})

    await client.delete(f"{API}/wiki-pages/w1", headers=agent)
    assert (await _list(client, headers))[0]["action"] == "deleted"


async def test_user_plugin_writes_by_an_agent_are_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    manifest = json.dumps({"id": "box", "name": {"en": "Box plot"}})
    plugin = {"id": "pl1", "workspaceId": ws, "files": {"plugin.json": manifest, "main.R": "x"}}
    await client.post(f"{API}/user-plugins", headers=headers, json=plugin)
    assert await _list(client, headers) == []

    await client.patch(f"{API}/user-plugins/pl1", headers=agent, json={"files": plugin["files"]})
    assert await _list(client, headers) == []

    await client.patch(f"{API}/user-plugins/pl1", headers=agent, json={"files": {**plugin["files"], "main.R": "y"}})
    [one_file] = await _list(client, headers)
    assert (one_file["entityType"], one_file["entityId"], one_file["label"]) == ("user_plugin", "pl1", {"en": "Box plot"})
    assert one_file["detail"] == {"workspaceId": ws, "part": "file", "action": "updated", "name": "main.R"}

    await client.patch(f"{API}/user-plugins/pl1", headers=agent, json={"files": {"plugin.json": manifest, "a.py": "1", "b.py": "2"}})
    assert (await _list(client, headers))[0]["detail"] == {"workspaceId": ws}

    await client.post(f"{API}/user-plugins", headers=agent, json={"id": "pl2", "workspaceId": ws, "entityId": "raw"})
    assert (await _list(client, headers))[0]["label"] == {"en": "raw"}

    await client.delete(f"{API}/user-plugins/pl1", headers=agent)
    deleted = (await _list(client, headers))[0]
    assert (deleted["action"], deleted["label"]) == ("deleted", {"en": "Box plot"})
