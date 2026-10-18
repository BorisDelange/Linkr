from app.services import notification_hub
from tests.test_cohorts import API, _admin_headers, _cohort, _create_user, _project

MCP = {"X-Linkr-Client": "mcp"}


async def _list(client, headers) -> list[dict]:
    return (await client.get(f"{API}/notifications", headers=headers)).json()


async def test_only_external_writes_are_notified(client):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)

    # The app's own UI: the user saw it happen, nothing recorded.
    await _cohort(client, headers, proj, cid="ui")
    assert await _list(client, headers) == []

    await _cohort(client, {**headers, **MCP}, proj, cid="agent")
    [created] = await _list(client, headers)
    assert created["action"] == "created" and created["entityType"] == "cohort"
    assert created["entityId"] == "agent" and created["projectUid"] == proj
    assert created["source"] == "mcp" and created["readAt"] is None


async def test_a_run_refreshes_but_does_not_notify(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    proj = await _project(client, headers)
    await _cohort(client, agent, proj)
    queue = notification_hub.subscribe(1)
    try:
        await client.patch(f"{API}/cohorts/c1", headers=agent, json={"resultCount": 3, "attrition": []})
        event = queue.get_nowait()
        assert event["action"] == "updated" and "notification" not in event
        assert len(await _list(client, headers)) == 1

        await client.patch(f"{API}/cohorts/c1", headers=agent, json={"name": {"en": "Renamed"}})
        event = queue.get_nowait()
        assert event["notification"]["label"] == {"en": "Renamed"}
    finally:
        notification_hub.unsubscribe(1, queue)

    await client.delete(f"{API}/cohorts/c1", headers=agent)
    latest = (await _list(client, headers))[0]
    assert latest["action"] == "deleted" and latest["label"] == {"en": "Renamed"}


async def test_read_and_clear_are_per_user(client, db):
    admin = await _admin_headers(client)
    other = await _create_user(db, client, "bob")
    proj = await _project(client, admin)
    await _cohort(client, {**admin, **MCP}, proj)
    assert await _list(client, other) == []

    assert (await client.post(f"{API}/notifications/read", headers=admin)).status_code == 204
    assert (await _list(client, admin))[0]["readAt"] is not None

    assert (await client.delete(f"{API}/notifications", headers=admin)).status_code == 204
    assert await _list(client, admin) == []


async def _undo(client, headers, notification_id):
    return await client.post(f"{API}/notifications/{notification_id}/undo", headers=headers)


async def test_undo_reverses_each_kind_of_cohort_change(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    proj = await _project(client, headers)

    await _cohort(client, agent, proj)
    await client.patch(f"{API}/cohorts/c1", headers=agent, json={"name": {"en": "Renamed"}})
    renamed, created = await _list(client, headers)
    # Only the latest change to an item can be undone: the older one would
    # overwrite what came after it.
    assert renamed["undoable"] and not created["undoable"]
    assert (await _undo(client, headers, created["id"])).status_code == 409

    assert (await _undo(client, headers, renamed["id"])).status_code == 204
    assert (await client.get(f"{API}/cohorts/c1", headers=headers)).json()["name"] == "Adults"
    renamed, created = await _list(client, headers)
    assert renamed["undoneAt"] and created["undoable"]

    await _undo(client, headers, created["id"])
    assert (await client.get(f"{API}/cohorts/c1", headers=headers)).status_code == 404


async def test_undo_recreates_a_deleted_cohort_and_widget(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    proj = await _project(client, headers)
    await _cohort(client, headers, proj)
    await client.delete(f"{API}/cohorts/c1", headers=agent)
    [deleted] = await _list(client, headers)
    await _undo(client, headers, deleted["id"])
    assert (await client.get(f"{API}/cohorts/c1", headers=headers)).json()["name"] == "Adults"

    await client.post(f"{API}/dashboards", headers=headers, json={"id": "d1", "projectUid": proj, "name": {"en": "D"}})
    await client.post(f"{API}/dashboards/tabs", headers=headers, json={"id": "t1", "dashboardId": "d1", "name": {"en": "T"}})
    await client.post(f"{API}/dashboards/widgets", headers=headers, json={
        "id": "w1", "tabId": "t1", "name": {"en": "Chart"}, "layout": {"x": 0, "y": 0, "w": 24, "h": 12},
        "source": {"type": "plugin", "pluginId": "p", "config": {"a": 1}},
    })
    await client.delete(f"{API}/dashboards/widgets/w1", headers=agent)
    latest = (await _list(client, headers))[0]
    assert latest["entityType"] == "dashboard" and latest["detail"]["part"] == "widget"
    await _undo(client, headers, latest["id"])
    widget = (await client.get(f"{API}/dashboards/widgets/w1", headers=headers)).json()
    assert widget["source"]["config"] == {"a": 1} and widget["layout"]["w"] == 24


async def test_scripts_and_concept_lists_written_by_an_agent_are_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    proj = await _project(client, headers)

    body = {"projectUid": proj, "path": "analysis/t1.R", "content": "1"}
    assert (await client.post(f"{API}/ide-files", headers=headers, json=body)).status_code == 201
    assert await _list(client, headers) == []
    r = await client.put(f"{API}/ide-files/content", headers=agent, json={**body, "content": "2"})
    assert r.status_code == 204
    r = await client.post(f"{API}/ide-files/delete", headers=agent, json={"projectUid": proj, "path": "analysis/t1.R"})
    assert r.status_code == 204
    deleted, updated = await _list(client, headers)
    assert (updated["entityType"], updated["action"], updated["entityId"]) == ("script", "updated", "analysis/t1.R")
    assert deleted["action"] == "deleted" and not deleted["undoable"]

    r = await client.post(f"{API}/concept-lists", headers=agent, json={
        "id": "cl1", "projectUid": proj, "name": {"en": "Labs"}, "items": [{"conceptId": 1}],
    })
    assert r.status_code == 201
    latest = (await _list(client, headers))[0]
    assert (latest["entityType"], latest["action"], latest["label"]) == ("concept_list", "created", {"en": "Labs"})


async def test_etl_writes_by_an_agent_are_notified_and_undoable(client):
    from tests.test_etl_pipelines import _pipeline, _workspace

    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    await _pipeline(client, headers, ws)
    folder = {"id": "f0", "pipelineId": "p1", "name": "sql", "type": "folder"}
    await client.post(f"{API}/etl-files", headers=headers, json=folder)
    assert await _list(client, headers) == []

    script = {"id": "f1", "pipelineId": "p1", "name": "42_eras.sql", "parentId": "f0", "content": "SELECT 1"}
    assert (await client.post(f"{API}/etl-files", headers=agent, json=script)).status_code == 201
    await client.patch(f"{API}/etl-files/f1", headers=agent, json={"content": "SELECT 2"})
    updated, created = await _list(client, headers)
    assert (created["entityType"], created["entityId"], created["label"]) == ("etl_pipeline", "p1", {"en": "ETL"})
    assert created["detail"] == {
        "workspaceId": ws, "part": "script", "action": "created", "name": "sql/42_eras.sql", "fileId": "f1",
    }
    assert updated["detail"]["action"] == "updated" and updated["undoable"] and not created["undoable"]

    # Rewriting the same content, or only moving the script in the run order:
    # nothing to tell the user.
    await client.patch(f"{API}/etl-files/f1", headers=agent, json={"content": "SELECT 2"})
    await client.patch(f"{API}/etl-files/f1", headers=agent, json={"order": 5})
    await client.patch(f"{API}/etl-pipelines/p1", headers=agent, json={"config": {"excludedFiles": []}})
    assert len(await _list(client, headers)) == 2

    assert (await _undo(client, headers, updated["id"])).status_code == 204
    files = (await client.get(f"{API}/etl-pipelines/p1/files", headers=headers)).json()
    assert next(f for f in files if f["id"] == "f1")["content"] == "SELECT 1"

    await client.delete(f"{API}/etl-files/f1", headers=agent)
    deleted = (await _list(client, headers))[0]
    assert deleted["detail"]["action"] == "deleted" and deleted["undoable"]
    await _undo(client, headers, deleted["id"])
    files = (await client.get(f"{API}/etl-pipelines/p1/files", headers=headers)).json()
    restored = next(f for f in files if f["id"] == "f1")
    assert (restored["content"], restored["parentId"], restored["order"]) == ("SELECT 1", "f0", 5)

    await client.patch(f"{API}/etl-pipelines/p1", headers=agent, json={"name": {"en": "Renamed"}})
    renamed = (await _list(client, headers))[0]
    assert renamed["label"] == {"en": "Renamed"} and renamed["detail"] == {"workspaceId": ws}
    await _undo(client, headers, renamed["id"])
    assert (await client.get(f"{API}/etl-pipelines/p1", headers=headers)).json()["name"] == {"en": "ETL"}


async def test_an_etl_run_refreshes_but_does_not_notify(client):
    from tests.test_etl_pipelines import _pipeline, _workspace

    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    await _pipeline(client, headers, ws)
    queue = notification_hub.subscribe(1)
    try:
        run = {"id": "r1", "pipelineId": "p1", "startedAt": "2026-10-18T10:00:00Z", "status": "running"}
        assert (await client.post(f"{API}/etl-runs", headers=agent, json=run)).status_code == 201
        event = queue.get_nowait()
        assert (event["entityType"], event["entityId"]) == ("etl_run", "p1") and "notification" not in event
    finally:
        notification_hub.unsubscribe(1, queue)
    assert await _list(client, headers) == []

    await client.post(f"{API}/etl-pipelines", headers=agent, json={"id": "p2", "workspaceId": ws, "name": {"en": "New"}})
    created = (await _list(client, headers))[0]
    assert created["action"] == "created" and created["undoable"]
    await _undo(client, headers, created["id"])
    assert (await client.get(f"{API}/etl-pipelines/p2", headers=headers)).status_code == 404
