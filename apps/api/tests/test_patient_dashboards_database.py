"""A database cohort's patient board: the one that cohort's patients are
reviewed through. One per cohort, under the database — gated by its
permissions, gone with the cohort or the database."""

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


async def _cohort(client, headers, ds: str, cid="c1") -> str:
    return (await client.post(f"{API}/cohorts", headers=headers, json={
        "id": cid, "ownerDataSourceId": ds, "name": {"en": cid}, "level": "patient", "criteriaTree": {},
    })).json()["id"]


async def _board(client, headers, ds: str, bid="b1", cohort="c1"):
    return await client.post(f"{API}/patient-dashboards", headers=headers, json={
        "id": bid, "ownerDataSourceId": ds, "ownerCohortId": cohort, "name": {"en": "Review"},
    })


async def test_one_board_per_cohort_running_on_its_database(client):
    headers = await _admin(client)
    _, ds = await _database(client, headers)
    await _cohort(client, headers, ds, "c1")
    await _cohort(client, headers, ds, "c2")
    r = await _board(client, headers, ds)
    assert r.status_code == 201, r.text
    assert r.json()["ownerDataSourceId"] == ds and r.json()["dataSourceId"] == ds
    assert r.json()["ownerCohortId"] == "c1" and r.json()["projectUid"] is None
    assert (await _board(client, headers, ds, bid="b2")).status_code == 409
    assert (await _board(client, headers, ds, bid="b2", cohort="c2")).status_code == 201
    # A database board needs a cohort of that very database.
    assert (await _board(client, headers, ds, bid="b3", cohort=None)).status_code == 422
    _, other = await _database(client, headers)
    await _cohort(client, headers, other, "c9")
    assert (await _board(client, headers, ds, bid="b3", cohort="c9")).status_code == 422

    listed = (await client.get(f"{API}/patient-dashboards?dataSourceId={ds}", headers=headers)).json()
    assert sorted(b["id"] for b in listed) == ["b1", "b2"]

    tab = await client.post(f"{API}/patient-dashboards/tabs", headers=headers, json={
        "id": "t1", "patientDashboardId": "b1", "name": {"en": "Tab"}, "displayOrder": 0,
    })
    assert tab.status_code == 201, tab.text


async def test_board_follows_database_permissions_and_lifetime(client, db):
    admin = await _admin(client)
    ws, ds = await _database(client, admin)
    await _cohort(client, admin, ds)
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

    # Gone with its cohort; and with the database, like everything under it.
    await client.delete(f"{API}/cohorts/c1", headers=admin)
    assert (await client.get(f"{API}/patient-dashboards/b1", headers=admin)).status_code == 404


async def test_a_board_has_exactly_one_owner(client):
    headers = await _admin(client)
    r = await client.post(f"{API}/patient-dashboards", headers=headers, json={"id": "x", "name": {}})
    assert r.status_code == 422
