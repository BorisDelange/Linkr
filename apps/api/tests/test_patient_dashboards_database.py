"""A database's own patient board: the one the cohorts of the database page are
reviewed through. One per database, gated by the database's permissions, gone
with the database."""

from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _database(client, headers) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "omop", "name": "OMOP", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })).json()["id"]
    return ws, ds


async def _board(client, headers, ds: str, bid="b1"):
    return await client.post(f"{API}/patient-dashboards", headers=headers, json={
        "id": bid, "ownerDataSourceId": ds, "name": {"en": "Review"},
    })


async def test_one_board_per_database_running_on_it(client):
    headers = await _admin(client)
    _, ds = await _database(client, headers)
    r = await _board(client, headers, ds)
    assert r.status_code == 201, r.text
    assert r.json()["ownerDataSourceId"] == ds and r.json()["dataSourceId"] == ds
    assert r.json()["projectUid"] is None
    assert (await _board(client, headers, ds, bid="b2")).status_code == 409

    listed = (await client.get(f"{API}/patient-dashboards?dataSourceId={ds}", headers=headers)).json()
    assert [b["id"] for b in listed] == ["b1"]

    tab = await client.post(f"{API}/patient-dashboards/tabs", headers=headers, json={
        "id": "t1", "patientDashboardId": "b1", "name": {"en": "Tab"}, "displayOrder": 0,
    })
    assert tab.status_code == 201, tab.text


async def test_board_follows_database_permissions_and_lifetime(client, db):
    admin = await _admin(client)
    ws, ds = await _database(client, admin)
    await _board(client, admin, ds)
    viewer = User(username="viewer", password_hash=hash_password("pw"), role="user")
    db.add(viewer)
    await db.commit()
    token = (await client.post(f"{API}/auth/login", json={"username": "viewer", "password": "pw"})).json()["access_token"]
    vh = {"Authorization": f"Bearer {token}"}
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": viewer.id, "role": "viewer"})

    assert (await client.get(f"{API}/patient-dashboards/b1", headers=vh)).status_code == 200
    assert (await client.patch(f"{API}/patient-dashboards/b1", headers=vh, json={"name": {"en": "X"}})).status_code == 403

    await client.delete(f"{API}/data-sources/{ds}", headers=admin)
    assert (await client.get(f"{API}/patient-dashboards/b1", headers=admin)).status_code == 404


async def test_a_board_has_exactly_one_owner(client):
    headers = await _admin(client)
    r = await client.post(f"{API}/patient-dashboards", headers=headers, json={"id": "x", "name": {}})
    assert r.status_code == 422
