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
