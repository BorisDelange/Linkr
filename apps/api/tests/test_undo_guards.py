from datetime import datetime, timezone

from app.models.notification import Notification
from tests.test_cohorts import API, _admin_headers, _cohort, _create_user, _project
from tests.test_etl_pipelines import _pipeline, _workspace

MCP = {"X-Linkr-Client": "mcp"}


async def _list(client, headers) -> list[dict]:
    return (await client.get(f"{API}/notifications", headers=headers)).json()


async def _undo(client, headers, notification_id):
    return await client.post(f"{API}/notifications/{notification_id}/undo", headers=headers)


def _code(response) -> str:
    return response.json()["detail"]["code"]


async def _script(client, headers, ws) -> dict:
    await _pipeline(client, headers, ws)
    script = {"id": "f1", "pipelineId": "p1", "name": "10_load.sql", "content": "SELECT 1"}
    assert (await client.post(f"{API}/etl-files", headers=headers, json=script)).status_code == 201
    return script


async def _files(client, headers, pid="p1") -> dict[str, dict]:
    return {f["id"]: f for f in (await client.get(f"{API}/etl-pipelines/{pid}/files", headers=headers)).json()}


async def _content(client, headers) -> str:
    return (await _files(client, headers))["f1"]["content"]


async def test_undo_never_overwrites_a_later_edit_made_in_the_app(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await _script(client, headers, ws)
    await client.patch(f"{API}/etl-files/f1", headers={**headers, **MCP}, json={"content": "SELECT 2"})
    [updated] = await _list(client, headers)

    # The UI leaves no notification: only the item itself shows the edit.
    await client.patch(f"{API}/etl-files/f1", headers=headers, json={"content": "SELECT 3"})
    response = await _undo(client, headers, updated["id"])
    assert response.status_code == 409 and _code(response) == "changed"
    assert await _content(client, headers) == "SELECT 3"


async def test_undo_ignores_later_writes_to_other_fields(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await _script(client, headers, ws)
    await client.patch(f"{API}/etl-files/f1", headers={**headers, **MCP}, json={"content": "SELECT 2"})
    [updated] = await _list(client, headers)

    await client.patch(f"{API}/etl-files/f1", headers=headers, json={"order": 7, "disabled": True})
    assert (await _undo(client, headers, updated["id"])).status_code == 204
    assert await _content(client, headers) == "SELECT 1"


async def test_undoing_a_creation_never_deletes_what_was_put_in_it(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    await client.post(f"{API}/etl-pipelines", headers=agent, json={"id": "p2", "workspaceId": ws, "name": {"en": "New"}})
    [created] = await _list(client, headers)
    script = {"id": "f9", "pipelineId": "p2", "name": "mine.sql", "content": "SELECT 1"}
    await client.post(f"{API}/etl-files", headers=headers, json=script)

    response = await _undo(client, headers, created["id"])
    assert response.status_code == 409 and _code(response) == "not_empty"
    assert "f9" in await _files(client, headers, "p2")

    # Emptied again, the creation can go.
    await client.delete(f"{API}/etl-files/f9", headers=headers)
    assert (await _undo(client, headers, created["id"])).status_code == 204
    assert (await client.get(f"{API}/etl-pipelines/p2", headers=headers)).status_code == 404


async def test_undoing_a_creation_edited_since_is_refused(client):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    await _cohort(client, {**headers, **MCP}, proj)
    [created] = await _list(client, headers)

    # A run only records its outcome: the creation stays undoable.
    await client.patch(f"{API}/cohorts/c1", headers=headers, json={"resultCount": 3, "attrition": []})
    assert (await _list(client, headers))[0]["undoable"]

    await client.patch(f"{API}/cohorts/c1", headers=headers, json={"name": {"en": "Mine now"}})
    response = await _undo(client, headers, created["id"])
    assert response.status_code == 409 and _code(response) == "changed"
    assert (await client.get(f"{API}/cohorts/c1", headers=headers)).status_code == 200


async def test_recreating_a_deleted_file_refuses_an_id_taken_again(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    script = await _script(client, headers, ws)
    await client.delete(f"{API}/etl-files/f1", headers={**headers, **MCP})
    [deleted] = await _list(client, headers)

    # File ids derive from the path: the user re-creating it takes the same id.
    await client.post(f"{API}/etl-files", headers=headers, json={**script, "content": "SELECT 9"})
    response = await _undo(client, headers, deleted["id"])
    assert response.status_code == 409 and _code(response) == "exists"
    assert await _content(client, headers) == "SELECT 9"


async def test_a_deleted_pipeline_closes_the_undo_of_its_earlier_changes(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    await _pipeline(client, headers, ws)
    await client.patch(f"{API}/etl-pipelines/p1", headers=agent, json={"name": {"en": "Renamed"}})
    assert (await _list(client, headers))[0]["undoable"]

    await client.delete(f"{API}/etl-pipelines/p1", headers=agent)
    deleted, renamed = await _list(client, headers)
    assert deleted["action"] == "deleted" and not deleted["undoable"] and not renamed["undoable"]


async def test_a_change_recorded_without_a_guard_is_not_undoable(client, db):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    await _cohort(client, headers, proj)
    db.add(Notification(
        created_at=datetime.now(timezone.utc), user_id=1, source="mcp", action="created",
        entity_type="cohort", entity_id="c1", project_uid=proj, label={"en": "Cohort"},
        undo={"kind": "cohort", "op": "delete", "id": "c1"},
    ))
    await db.commit()
    [legacy] = await _list(client, headers)
    assert not legacy["undoable"]
    assert (await _undo(client, headers, legacy["id"])).status_code == 409
    assert (await client.get(f"{API}/cohorts/c1", headers=headers)).status_code == 200


async def test_only_the_user_the_change_was_made_for_can_undo_it(client, db):
    headers = await _admin_headers(client)
    other = await _create_user(db, client, "bob")
    proj = await _project(client, headers)
    await _cohort(client, {**headers, **MCP}, proj)
    [created] = await _list(client, headers)
    assert (await _undo(client, other, created["id"])).status_code == 404
    assert (await client.get(f"{API}/cohorts/c1", headers=headers)).status_code == 200


async def test_undoing_a_dashboard_tab_creation_keeps_the_widgets_put_in_it(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    proj = await _project(client, headers)
    await client.post(f"{API}/dashboards", headers=headers, json={"id": "d1", "projectUid": proj, "name": {"en": "D"}})
    await client.post(f"{API}/dashboards/tabs", headers=agent, json={"id": "t1", "dashboardId": "d1", "name": {"en": "T"}})
    [created] = await _list(client, headers)
    await client.post(f"{API}/dashboards/widgets", headers=headers, json={
        "id": "w1", "tabId": "t1", "name": {"en": "Chart"}, "layout": {"x": 0, "y": 0, "w": 24, "h": 12},
        "source": {"type": "plugin", "pluginId": "p", "config": {}},
    })

    response = await _undo(client, headers, created["id"])
    assert response.status_code == 409 and _code(response) == "not_empty"
    assert (await client.get(f"{API}/dashboards/widgets/w1", headers=headers)).status_code == 200
