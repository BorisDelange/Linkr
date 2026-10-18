"""Writes by an external client (an agent over MCP) on DQ rule sets, patient
boards, the project pipeline, datasets and cohort runs reach the bell; the app's
own writes, unchanged writes and runs do not."""

from app.services import notification_hub
from tests.test_cohorts import API, _admin_headers, _cohort, _project
from tests.test_notifications import MCP, _list


async def _workspace(client, headers) -> str:
    return (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]


def _check(cid: str, name: str, **over) -> dict:
    return {"id": cid, "ruleSetId": "r1", "name": name, "category": "plausibility",
            "subcategory": "temporal", "severity": "warning", "threshold": 0, "sql": "SELECT 1", **over}


def _drain(queue) -> list[dict]:
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


async def test_dq_rule_set_writes_by_an_agent_are_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    rule_set = {"id": "r1", "workspaceId": ws, "name": {"en": "Quality"}, "dataSourceId": "src-1"}

    await client.post(f"{API}/dq-rule-sets", headers=headers, json={**rule_set, "id": "ui"})
    await client.patch(f"{API}/dq-rule-sets/ui", headers=headers, json={"name": {"en": "UI"}})
    assert await _list(client, headers) == []

    assert (await client.post(f"{API}/dq-rule-sets", headers=agent, json=rule_set)).status_code == 201
    [created] = await _list(client, headers)
    assert (created["entityType"], created["entityId"], created["projectUid"]) == ("dq_rule_set", "r1", None)
    assert created["label"] == {"en": "Quality"} and created["detail"] == {"workspaceId": ws}

    await client.patch(f"{API}/dq-rule-sets/r1", headers=agent, json={"checkGroups": ["person"]})
    assert (await _list(client, headers))[0]["action"] == "updated"
    count = len(await _list(client, headers))
    # Same value again, or only the cached outcome of a run: nothing to tell.
    await client.patch(f"{API}/dq-rule-sets/r1", headers=agent, json={"checkGroups": ["person"]})
    await client.patch(f"{API}/dq-rule-sets/r1", headers=agent, json={"lastScore": 0.9, "status": "active"})
    assert len(await _list(client, headers)) == count

    await client.post(f"{API}/dq-custom-checks", headers=agent, json=_check("c1", "Birth before death"))
    one = (await _list(client, headers))[0]
    assert one["entityId"] == "r1" and one["detail"] == {
        "workspaceId": ws, "part": "check", "action": "created", "name": "Birth before death",
    }

    batch = [_check("c2", "A"), _check("c3", "B")]
    assert (await client.post(f"{API}/dq-rule-sets/r1/checks", headers=agent, json=batch)).status_code == 201
    many = (await _list(client, headers))[0]
    assert many["detail"]["action"] == "created" and many["detail"]["count"] == 2

    count = len(await _list(client, headers))
    await client.patch(f"{API}/dq-custom-checks/c1", headers=agent, json={"name": "Birth before death"})
    await client.patch(f"{API}/dq-custom-checks/c1", headers=agent, json={"order": 7})
    await client.patch(f"{API}/dq-rule-sets/r1/checks", headers=agent, json=[{"id": "c2", "order": 3}])
    assert len(await _list(client, headers)) == count

    await client.patch(f"{API}/dq-custom-checks/c1", headers=agent, json={"severity": "error"})
    assert (await _list(client, headers))[0]["detail"]["action"] == "updated"
    await client.post(f"{API}/dq-rule-sets/r1/checks/batch-delete", headers=agent, json={"ids": ["c2", "c3"]})
    assert (await _list(client, headers))[0]["detail"]["count"] == 2
    await client.delete(f"{API}/dq-custom-checks/c1", headers=agent)
    assert (await _list(client, headers))[0]["detail"]["name"] == "Birth before death"

    await client.delete(f"{API}/dq-rule-sets/r1", headers=agent)
    deleted = (await _list(client, headers))[0]
    assert deleted["action"] == "deleted" and deleted["label"] == {"en": "Quality"}


async def test_a_dq_run_refreshes_but_does_not_notify(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    ws = await _workspace(client, headers)
    await client.post(f"{API}/dq-rule-sets", headers=headers, json={
        "id": "r1", "workspaceId": ws, "name": {"en": "Quality"}, "dataSourceId": "src-1",
    })
    queue = notification_hub.subscribe(1)
    try:
        run = {"id": "run1", "ruleSetId": "r1", "dataSourceId": "src-1",
               "startedAt": "2026-10-18T10:00:00Z", "status": "running"}
        assert (await client.post(f"{API}/dq-run-history", headers=agent, json=run)).status_code == 201
        await client.patch(f"{API}/dq-run-history/run1", headers=agent, json={"status": "success", "score": 1})
        await client.delete(f"{API}/dq-run-history/run1", headers=agent)
        events = _drain(queue)
        assert len(events) == 3
        assert all(
            (e["entityType"], e["entityId"], e["workspaceId"]) == ("dq_run", "r1", ws) and "notification" not in e
            for e in events
        )
    finally:
        notification_hub.unsubscribe(1, queue)
    assert await _list(client, headers) == []


async def test_patient_board_writes_by_an_agent_are_notified(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    proj = await _project(client, headers)

    await client.post(f"{API}/patient-dashboards", headers=headers, json={"id": "ui", "projectUid": proj, "name": {"en": "UI"}})
    assert await _list(client, headers) == []

    await client.post(f"{API}/patient-dashboards", headers=agent, json={"id": "b1", "projectUid": proj, "name": {"en": "Review"}})
    [created] = await _list(client, headers)
    assert (created["entityType"], created["entityId"], created["projectUid"]) == ("patient_board", "b1", proj)
    assert created["label"] == {"en": "Review"} and created["detail"] is None

    await client.post(f"{API}/patient-dashboards/tabs", headers=agent, json={
        "id": "t1", "patientDashboardId": "b1", "name": {"en": "Labs"}, "displayOrder": 0,
    })
    await client.post(f"{API}/patient-dashboards/widgets", headers=agent, json={
        "id": "w1", "tabId": "t1", "name": {"en": "Timeline"}, "pluginId": "timeline",
    })
    widget, tab = (await _list(client, headers))[:2]
    assert tab["detail"] == {"part": "tab", "action": "created", "name": {"en": "Labs"}}
    assert widget["entityId"] == "b1" and widget["detail"]["part"] == "widget"

    count = len(await _list(client, headers))
    await client.patch(f"{API}/patient-dashboards/widgets/w1", headers=agent, json={"name": {"en": "Timeline"}})
    await client.patch(f"{API}/patient-dashboards/tabs/t1", headers=agent, json={"displayOrder": 2})
    await client.patch(f"{API}/patient-dashboards/b1", headers=agent, json={"displayOrder": 4})
    assert len(await _list(client, headers)) == count

    await client.patch(f"{API}/patient-dashboards/widgets/w1", headers=agent, json={"config": {"x": 1}})
    await client.delete(f"{API}/patient-dashboards/tabs/t1", headers=agent)
    deleted_tab, updated_widget = (await _list(client, headers))[:2]
    assert updated_widget["detail"]["action"] == "updated"
    assert deleted_tab["detail"] == {"part": "tab", "action": "deleted", "name": {"en": "Labs"}}

    await client.delete(f"{API}/patient-dashboards/b1", headers=agent)
    assert (await _list(client, headers))[0]["action"] == "deleted"


async def test_a_database_board_names_its_workspace_and_database(client):
    from tests.test_patient_dashboards_database import _board, _database
    from tests.test_patient_dashboards_database import _cohort as _db_cohort

    headers = await _admin_headers(client)
    ws, ds = await _database(client, headers)
    await _db_cohort(client, headers, ds, "c1")
    assert (await _board(client, {**headers, **MCP}, ds)).status_code == 201
    [created] = await _list(client, headers)
    assert created["projectUid"] is None
    assert created["detail"] == {"workspaceId": ws, "dataSourceId": ds, "cohortId": "c1"}


async def test_project_pipeline_writes_name_the_node(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    proj = await _project(client, headers)
    await client.post(f"{API}/pipelines", headers=agent, json={
        "id": "p1", "projectUid": proj, "name": {"en": "Main pipeline"}, "nodes": [], "edges": [],
    })
    [created] = await _list(client, headers)
    assert (created["entityType"], created["entityId"], created["projectUid"]) == ("project_pipeline", "p1", proj)
    assert created["label"] == {"en": "Main pipeline"}

    node = {"id": "n1", "type": "cohort", "position": {"x": 0, "y": 0},
            "data": {"label": "Adults", "type": "cohort", "status": "idle"}}
    await client.patch(f"{API}/pipelines/p1", headers=agent, json={"nodes": [node]})
    added = (await _list(client, headers))[0]
    assert added["detail"] == {"part": "node", "action": "created", "name": {"en": "Adults"}}

    queue = notification_hub.subscribe(1)
    try:
        ran = {**node, "data": {**node["data"], "status": "success", "rowCount": 12}}
        await client.patch(f"{API}/pipelines/p1", headers=agent, json={"nodes": [ran]})
        [event] = _drain(queue)
        assert event["entityType"] == "project_pipeline" and "notification" not in event
        await client.patch(f"{API}/pipelines/p1", headers=agent, json={"nodes": [ran]})
        assert _drain(queue) == []
    finally:
        notification_hub.unsubscribe(1, queue)

    second = {**node, "id": "n2", "data": {**node["data"], "label": "Kids"}}
    await client.patch(f"{API}/pipelines/p1", headers=agent, json={
        "nodes": [ran, second], "edges": [{"id": "e1", "source": "n1", "target": "n2"}],
    })
    assert (await _list(client, headers))[0]["detail"]["name"] == {"en": "Kids"}
    await client.patch(f"{API}/pipelines/p1", headers=agent, json={"edges": []})
    assert (await _list(client, headers))[0]["detail"] is None

    await client.patch(f"{API}/pipelines/p1", headers=headers, json={"nodes": []})
    assert len(await _list(client, headers)) == 4


async def test_dataset_gaps_are_notified(client):
    from app.services import project_fs

    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    proj = await _project(client, headers)

    await client.post(f"{API}/dataset-files/folder", headers=agent, json={"projectUid": proj, "path": "raw"})
    folder = (await _list(client, headers))[0]
    assert (folder["entityType"], folder["action"], folder["entityId"]) == ("dataset", "created", "raw")
    assert folder["detail"]["part"] == "folder"
    await client.post(f"{API}/dataset-files/folder", headers=agent, json={"projectUid": proj, "path": "raw"})
    assert len(await _list(client, headers)) == 1

    r = await client.post(f"{API}/dataset-files/create-empty", headers=agent, json={
        "projectUid": proj, "path": "raw/entries.csv", "columns": [{"id": "col_id", "name": "id", "type": "number"}],
    })
    assert r.status_code == 201, r.text
    assert (await _list(client, headers))[0]["entityId"] == "raw/entries.csv"

    (project_fs.datasets_dir(proj) / "c.csv").write_text("age\n70\n")
    await client.post(f"{API}/dataset-files/reimport", headers=agent, json={
        "projectUid": proj, "path": "c.csv", "parseOptions": {"columnTypes": {"col_age": "string"}},
    })
    reimported = (await _list(client, headers))[0]
    assert (reimported["action"], reimported["entityId"]) == ("updated", "c.csv")

    a = (await client.post(f"{API}/dataset-files/analyses", headers=agent, json={
        "projectUid": proj, "datasetPath": "c.csv", "name": "Table 1", "type": "table1", "config": {},
    })).json()
    created = (await _list(client, headers))[0]
    assert created["entityId"] == "c.csv" and created["projectUid"] == proj
    assert created["detail"] == {"part": "analysis", "action": "created", "name": {"en": "Table 1"}}

    count = len(await _list(client, headers))
    await client.patch(f"{API}/dataset-files/analyses/{a['id']}", headers=agent, json={"name": "Table 1"})
    assert len(await _list(client, headers)) == count
    await client.patch(f"{API}/dataset-files/analyses/{a['id']}", headers=agent, json={"config": {"by": "sex"}})
    await client.delete(f"{API}/dataset-files/analyses/{a['id']}", headers=agent)
    deleted, updated = (await _list(client, headers))[:2]
    assert updated["detail"]["action"] == "updated" and deleted["detail"]["action"] == "deleted"


async def test_run_cohort_does_not_notify(client):
    headers = await _admin_headers(client)
    agent = {**headers, **MCP}
    proj = await _project(client, headers)
    await _cohort(client, agent, proj)
    attrition = [{"nodeId": "__total__", "label": "All", "count": 3, "excluded": 0}]
    queue = notification_hub.subscribe(1)
    try:
        # What the MCP's run_cohort sends, twice: a refresh, then nothing at all.
        await client.patch(f"{API}/cohorts/c1", headers=agent, json={"resultCount": 3, "attrition": attrition})
        [event] = _drain(queue)
        assert event["entityType"] == "cohort" and "notification" not in event
        await client.patch(f"{API}/cohorts/c1", headers=agent, json={"resultCount": 3, "attrition": attrition})
        assert _drain(queue) == []
        await client.patch(f"{API}/cohorts/c1", headers=agent, json={"name": "Adults"})
        assert _drain(queue) == []
    finally:
        notification_hub.unsubscribe(1, queue)
    assert len(await _list(client, headers)) == 1
