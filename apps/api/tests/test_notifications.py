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
