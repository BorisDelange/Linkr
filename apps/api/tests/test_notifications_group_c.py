"""Writes by an external client (an agent over MCP) to databases, workspaces,
projects and data catalogs reach the notification centre; the app's own UI,
an unchanged PATCH and a side-effect write do not."""

from app.services import notification_hub
from tests.test_cohort_derive_routes import DDL, MEMBERSHIP, _derive, _managed
from tests.test_cohorts import API, _admin_headers
from tests.test_data_catalogs import _catalog

MCP = {"X-Linkr-Client": "mcp"}
PG = {"engine": "postgresql", "host": "h", "database": "d"}


async def _list(client, headers) -> list[dict]:
    return (await client.get(f"{API}/notifications", headers=headers)).json()


async def _workspace(client, headers) -> str:
    return (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]


def _database_body(ws: str, **extra) -> dict:
    return {"workspaceId": ws, "alias": "omop", "name": {"en": "OMOP"}, "sourceType": "database",
            "status": "configuring", **extra}


async def test_database_writes_by_an_agent_are_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)

    r = await client.post(f"{API}/data-sources", headers=headers, json=_database_body(ws, alias="ui", connectionConfig=PG))
    assert r.status_code == 201
    assert await _list(client, headers) == []

    r = await client.post(f"{API}/data-sources", headers=agent, json=_database_body(ws, connectionConfig=PG))
    ds = r.json()["id"]
    [created] = await _list(client, headers)
    assert (created["entityType"], created["action"], created["entityId"]) == ("database", "created", ds)
    assert created["projectUid"] is None and created["label"] == {"en": "OMOP"} and created["detail"] == {"workspaceId": ws}

    queue = notification_hub.subscribe(1)
    try:
        # What a retest writes back refreshes the open page, nothing more.
        await client.patch(f"{API}/data-sources/{ds}", headers=agent, json={"status": "error", "errorMessage": "down"})
        event = queue.get_nowait()
        assert (event["entityType"], event["entityId"]) == ("database", ds) and "notification" not in event
    finally:
        notification_hub.unsubscribe(1, queue)
    await client.patch(f"{API}/data-sources/{ds}", headers=agent, json={"name": {"en": "OMOP"}})
    assert len(await _list(client, headers)) == 1

    await client.patch(f"{API}/data-sources/{ds}", headers=agent, json={"readme": {"en": "# Hi"}})
    await client.delete(f"{API}/data-sources/{ds}", headers=agent)
    deleted, updated, _ = await _list(client, headers)
    assert updated["action"] == "updated" and updated["detail"] == {"workspaceId": ws}
    assert deleted["action"] == "deleted" and deleted["label"] == {"en": "OMOP"}


async def test_create_database_from_a_schema_is_one_notification(client):
    """The MCP's create_database chains POST, create-from-ddl and a status PATCH."""
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)

    body = _database_body(ws, connectionConfig={"engine": "duckdb", "managed": True})
    ds = (await client.post(f"{API}/data-sources", headers=agent, json=body)).json()["id"]
    assert (await client.post(f"{API}/data-sources/{ds}/create-from-ddl", headers=agent, json={"ddl": DDL})).status_code == 200
    await client.patch(f"{API}/data-sources/{ds}", headers=agent, json={"status": "connected", "errorMessage": None, "stats": {"tableCount": 3}})
    [created] = await _list(client, headers)
    assert (created["action"], created["entityId"]) == ("created", ds)

    # A rebuild of the tables is an update.
    await client.post(f"{API}/data-sources/{ds}/create-from-ddl", headers=agent, json={"ddl": DDL})
    assert (await _list(client, headers))[0]["action"] == "updated"

    # A row whose build never happened goes as quietly as it came.
    await client.delete(f"{API}/notifications", headers=headers)
    body = _database_body(ws, alias="empty", connectionConfig={"engine": "duckdb", "managed": True})
    empty = (await client.post(f"{API}/data-sources", headers=agent, json=body)).json()["id"]
    await client.delete(f"{API}/data-sources/{empty}", headers=agent)
    assert await _list(client, headers) == []


async def test_an_agent_derivation_into_a_new_database_is_not_announced_twice(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    src = await _managed(client, headers, ws, "src", seed=True)
    dst = await _managed(client, agent, ws, "cohort_five", seed=False)
    job = await _derive(client, agent, ws, src, {
        "membershipSql": MEMBERSHIP, "level": "patient",
        "target": {"kind": "new-database", "dataSourceId": dst},
        "derivedFrom": {"cohort": {"key": "five", "name": {"en": "Five"}}},
    })
    assert job["status"] == "done", job
    done, started = await _list(client, headers)
    assert started["action"] == "created" and started["detail"]["part"] == "derivation"
    assert done["detail"]["action"] == "done"


async def test_workspace_writes_by_an_agent_are_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    await _workspace(client, headers)
    assert await _list(client, headers) == []

    ws = (await client.post(f"{API}/workspaces", headers=agent, json={"name": {"en": "Agent WS"}})).json()["id"]
    await client.patch(f"{API}/workspaces/{ws}", headers=agent, json={"name": {"en": "Agent WS"}})
    await client.patch(f"{API}/workspaces/{ws}", headers=agent, json={"readme": {"en": "# Readme"}})
    updated, created = await _list(client, headers)
    assert (created["entityType"], created["action"], created["entityId"]) == ("workspace", "created", ws)
    assert created["projectUid"] is None and created["detail"] == {"workspaceId": ws}
    assert updated["action"] == "updated" and updated["label"] == {"en": "Agent WS"}


async def test_project_writes_by_an_agent_are_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    ds = (await client.post(f"{API}/data-sources", headers=headers, json=_database_body(ws, connectionConfig=PG))).json()["id"]
    await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "UI"}, "workspaceId": ws})
    assert await _list(client, headers) == []

    uid = (await client.post(f"{API}/projects", headers=agent, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    [created] = await _list(client, headers)
    assert (created["entityType"], created["action"], created["entityId"], created["projectUid"]) == ("project", "created", uid, uid)
    assert created["label"] == {"en": "P"} and created["detail"] == {"workspaceId": ws}

    await client.patch(f"{API}/projects/{uid}", headers=agent, json={"linkedDataSourceIds": [ds]})
    await client.patch(f"{API}/projects/{uid}", headers=agent, json={"linkedDataSourceIds": [ds]})
    await client.patch(f"{API}/projects/{uid}", headers=agent, json={"config": {"versionedDataFiles": ["a.csv"]}})
    await client.patch(f"{API}/projects/{uid}", headers=agent, json={"linkedDataSourceIds": []})
    unlinked, linked, _ = await _list(client, headers)
    assert linked["detail"] == {"workspaceId": ws, "part": "database", "action": "linked", "name": {"en": "OMOP"}}
    assert unlinked["detail"]["action"] == "unlinked"

    await client.patch(f"{API}/projects/{uid}", headers=agent, json={"name": {"en": "Renamed"}})
    renamed = (await _list(client, headers))[0]
    assert renamed["label"] == {"en": "Renamed"} and renamed["detail"] == {"workspaceId": ws}


async def test_data_catalog_writes_by_an_agent_are_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    await _catalog(client, headers, ws, cid="ui")
    assert await _list(client, headers) == []

    await _catalog(client, agent, ws)
    [created] = await _list(client, headers)
    assert (created["entityType"], created["action"], created["entityId"]) == ("data_catalog", "created", "cat1")
    assert created["projectUid"] is None and created["label"] == {"en": "Catalog"} and created["detail"] == {"workspaceId": ws}

    queue = notification_hub.subscribe(1)
    try:
        await client.patch(f"{API}/data-catalogs/cat1", headers=agent, json={"status": "computing", "computedSteps": 1})
        await client.put(f"{API}/data-catalogs/cat1/results-cache", headers=agent, json={"computedAt": "2026-10-18T10:00:00Z", "payload": {}})
        await client.delete(f"{API}/data-catalogs/cat1/results-cache", headers=agent)
        events = [queue.get_nowait() for _ in range(3)]
        assert all(e["entityType"] == "data_catalog" and "notification" not in e for e in events)
    finally:
        notification_hub.unsubscribe(1, queue)
    await client.patch(f"{API}/data-catalogs/cat1", headers=agent, json={"name": {"en": "Catalog"}})
    assert len(await _list(client, headers)) == 1

    await client.patch(f"{API}/data-catalogs/cat1", headers=agent, json={"crossings": []})
    await client.delete(f"{API}/data-catalogs/cat1", headers=agent)
    deleted, updated, _ = await _list(client, headers)
    assert updated["action"] == "updated" and deleted["action"] == "deleted"
