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


async def _project(client, headers) -> str:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    return (await client.post(f"{API}/projects", headers=headers, json={
        "name": {"en": "P"}, "workspaceId": ws,
    })).json()["uid"]


async def _dashboard(client, headers, project_uid: str, did="d1") -> dict:
    return (await client.post(f"{API}/dashboards", headers=headers, json={
        "id": did, "projectUid": project_uid, "name": {"en": "Overview"},
        "filterConfig": [],
    })).json()


async def _tab(client, headers, dashboard_id: str, tid="t1") -> dict:
    return (await client.post(f"{API}/dashboards/tabs", headers=headers, json={
        "id": tid, "dashboardId": dashboard_id, "name": "Tab 1", "displayOrder": 0,
    })).json()


async def _widget(client, headers, tab_id: str, wid="w1", source=None) -> dict:
    return (await client.post(f"{API}/dashboards/widgets", headers=headers, json={
        "id": wid, "tabId": tab_id, "name": "Widget",
        "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
        "source": source or {"type": "inline", "language": "python", "code": "print(1)", "config": {}},
    })).json()


async def test_dashboard_crud(client):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    d = await _dashboard(client, headers, proj)
    assert d["projectUid"] == proj and d["name"] == {"en": "Overview"}
    assert d["origin"] == "user"

    listed = (await client.get(f"{API}/dashboards?projectUid={proj}", headers=headers)).json()
    assert [x["id"] for x in listed] == [d["id"]]

    r = await client.patch(f"{API}/dashboards/{d['id']}", headers=headers,
                           json={"name": {"en": "KPIs"}, "gridV": 2, "fitToHeight": True})
    assert r.json()["name"] == {"en": "KPIs"} and r.json()["gridV"] == 2
    assert r.json()["fitToHeight"] is True

    assert (await client.delete(f"{API}/dashboards/{d['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/dashboards/{d['id']}", headers=headers)).status_code == 404


async def test_tabs_and_widgets_hierarchy(client):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    d = await _dashboard(client, headers, proj)
    t = await _tab(client, headers, d["id"])
    w = await _widget(client, headers, t["id"])

    assert w["tabId"] == t["id"]
    assert w["source"]["type"] == "inline" and w["source"]["code"] == "print(1)"

    tabs = (await client.get(f"{API}/dashboards/{d['id']}/tabs", headers=headers)).json()
    assert [x["id"] for x in tabs] == [t["id"]]
    widgets = (await client.get(f"{API}/dashboards/tabs/{t['id']}/widgets", headers=headers)).json()
    assert [x["id"] for x in widgets] == [w["id"]]

    # Sub-tab nesting: parentTabId set/cleared distinguishes unset from null.
    sub = await _tab(client, headers, d["id"], tid="t2")
    r = await client.patch(f"{API}/dashboards/tabs/{sub['id']}", headers=headers,
                           json={"parentTabId": t["id"]})
    assert r.json()["parentTabId"] == t["id"]
    r = await client.patch(f"{API}/dashboards/tabs/{sub['id']}", headers=headers,
                           json={"parentTabId": None})
    assert r.json()["parentTabId"] is None

    r = await client.patch(f"{API}/dashboards/widgets/{w['id']}", headers=headers,
                           json={"layout": {"x": 6, "y": 0, "w": 6, "h": 4}})
    assert r.json()["layout"]["x"] == 6


async def test_cascade_delete_removes_children(client):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    d = await _dashboard(client, headers, proj)
    t = await _tab(client, headers, d["id"])
    w = await _widget(client, headers, t["id"])

    # Deleting the dashboard cascades to tabs and widgets (FK ondelete=CASCADE).
    assert (await client.delete(f"{API}/dashboards/{d['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/dashboards/tabs/{t['id']}", headers=headers)).status_code == 404
    assert (await client.get(f"{API}/dashboards/widgets/{w['id']}", headers=headers)).status_code == 404


async def test_delete_by_parent_batch(client):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    d = await _dashboard(client, headers, proj)
    t = await _tab(client, headers, d["id"])
    await _widget(client, headers, t["id"], wid="w1")
    await _widget(client, headers, t["id"], wid="w2")

    assert (await client.delete(f"{API}/dashboards/tabs/{t['id']}/widgets", headers=headers)).status_code == 204
    widgets = (await client.get(f"{API}/dashboards/tabs/{t['id']}/widgets", headers=headers)).json()
    assert widgets == []

    assert (await client.delete(f"{API}/dashboards/{d['id']}/tabs", headers=headers)).status_code == 204
    tabs = (await client.get(f"{API}/dashboards/{d['id']}/tabs", headers=headers)).json()
    assert tabs == []


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    proj = await _project(client, admin)
    d = await _dashboard(client, admin, proj)
    t = await _tab(client, admin, d["id"])
    w = await _widget(client, admin, t["id"])

    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/dashboards?projectUid={proj}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/dashboards/{d['id']}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/dashboards/tabs/{t['id']}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/dashboards/widgets/{w['id']}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/dashboards/{d['id']}", headers=other)).status_code == 403
