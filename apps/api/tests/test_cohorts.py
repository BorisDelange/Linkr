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


async def _cohort(client, headers, project_uid: str, cid="c1") -> dict:
    return (await client.post(f"{API}/cohorts", headers=headers, json={
        "id": cid, "projectUid": project_uid, "name": "Adults", "level": "patient",
        "criteriaTree": {"type": "group", "op": "and", "children": []},
    })).json()


async def test_cohort_crud(client):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    c = await _cohort(client, headers, proj)
    assert c["projectUid"] == proj and c["level"] == "patient"
    assert c["criteriaTree"]["op"] == "and" and c["schemaVersion"] == 5
    # A bare string still posts and reads back unchanged: LocalizedText tolerates
    # the pre-multilingual shape rather than rejecting older clients.
    assert c["name"] == "Adults"

    listed = (await client.get(f"{API}/cohorts?projectUid={proj}", headers=headers)).json()
    assert [x["id"] for x in listed] == [c["id"]]

    r = await client.patch(f"{API}/cohorts/{c['id']}", headers=headers,
                           json={"name": "Adults >18", "resultCount": 42})
    assert r.json()["name"] == "Adults >18" and r.json()["resultCount"] == 42

    assert (await client.delete(f"{API}/cohorts/{c['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/cohorts/{c['id']}", headers=headers)).status_code == 404


async def test_materialization_round_trip(client):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    c = await _cohort(client, headers, proj)

    mat = {
        "level": "patient",
        "ids": ["1", "2", "3"],
        "patientIds": ["1", "2", "3"],
        "count": 3,
        "materializedAt": "2026-07-09T09:30:00Z",
    }
    r = await client.patch(f"{API}/cohorts/{c['id']}", headers=headers,
                           json={"materialization": mat})
    assert r.json()["materialization"] == mat

    # Clearing the snapshot sets it back to null.
    r = await client.patch(f"{API}/cohorts/{c['id']}", headers=headers,
                           json={"materialization": None})
    assert r.json()["materialization"] is None


async def test_list_all_without_project_filter(client):
    # The store loads cohorts app-wide (no projectUid) — must not 422.
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    await _cohort(client, headers, proj)
    r = await client.get(f"{API}/cohorts", headers=headers)
    assert r.status_code == 200
    assert len(r.json()) == 1


async def test_localized_name_round_trips(client):
    # A cohort's name is a LocalizedString like every other entity's. Both
    # languages must survive the write, and editing one must not drop the other.
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    created = (await client.post(f"{API}/cohorts", headers=headers, json={
        "id": "c-i18n", "projectUid": proj, "level": "patient",
        "name": {"en": "Adults", "fr": "Adultes"},
        "description": {"en": "Over 50", "fr": "Plus de 50 ans"},
        "criteriaTree": {"kind": "group", "operator": "AND", "children": []},
    })).json()
    assert created["name"] == {"en": "Adults", "fr": "Adultes"}
    assert created["description"] == {"en": "Over 50", "fr": "Plus de 50 ans"}

    patched = (await client.patch(f"{API}/cohorts/c-i18n", headers=headers, json={
        "name": {"en": "Adult patients", "fr": "Adultes"},
    })).json()
    assert patched["name"] == {"en": "Adult patients", "fr": "Adultes"}
    assert patched["description"] == {"en": "Over 50", "fr": "Plus de 50 ans"}


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    proj = await _project(client, admin)
    c = await _cohort(client, admin, proj)

    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/cohorts?projectUid={proj}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/cohorts/{c['id']}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/cohorts/{c['id']}", headers=other)).status_code == 403


# --- Cohorts owned by a database (the database page's cohorts) ---------------


async def _user(db, client, username: str) -> tuple[int, dict]:
    user = User(username=username, password_hash=hash_password("pw"), role="user")
    db.add(user)
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw"})
    return user.id, {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _database(client, headers) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "omop", "name": "OMOP", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })).json()["id"]
    return ws, ds


async def _db_cohort(client, headers, ds: str, cid="dc1", **extra):
    return await client.post(f"{API}/cohorts", headers=headers, json={
        "id": cid, "ownerDataSourceId": ds, "name": "Adults", "level": "patient",
        "criteriaTree": {"type": "group", "op": "and", "children": []}, **extra,
    })


async def test_database_cohort_crud_and_listing(client):
    headers = await _admin_headers(client)
    _, ds = await _database(client, headers)
    proj = await _project(client, headers)
    await _cohort(client, headers, proj, cid="pc1")

    r = await _db_cohort(client, headers, ds, dataSourceId="some-other-db")
    assert r.status_code == 201, r.text
    c = r.json()
    # A database's cohort runs against that database, whatever was sent.
    assert c["ownerDataSourceId"] == ds and c["dataSourceId"] == ds and c["projectUid"] is None

    listed = (await client.get(f"{API}/cohorts?dataSourceId={ds}", headers=headers)).json()
    assert [x["id"] for x in listed] == ["dc1"]
    everything = (await client.get(f"{API}/cohorts", headers=headers)).json()
    assert {x["id"] for x in everything} == {"pc1", "dc1"}

    r = await client.patch(f"{API}/cohorts/dc1", headers=headers, json={"dataSourceId": "elsewhere"})
    assert r.json()["dataSourceId"] == ds


async def test_a_cohort_has_exactly_one_owner(client):
    headers = await _admin_headers(client)
    _, ds = await _database(client, headers)
    proj = await _project(client, headers)
    base = {"name": "X", "level": "patient", "criteriaTree": {}}
    none = await client.post(f"{API}/cohorts", headers=headers, json={"id": "a", **base})
    both = await client.post(f"{API}/cohorts", headers=headers, json={
        "id": "b", "projectUid": proj, "ownerDataSourceId": ds, **base,
    })
    assert none.status_code == 422 and both.status_code == 422


async def test_database_cohorts_follow_database_permissions(client, db):
    admin = await _admin_headers(client)
    ws, ds = await _database(client, admin)
    await _db_cohort(client, admin, ds)
    viewer_id, viewer = await _user(db, client, "viewer")
    _, outsider = await _user(db, client, "outsider")
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": viewer_id, "role": "viewer"})

    assert (await client.get(f"{API}/cohorts/dc1", headers=viewer)).status_code == 200
    assert (await client.get(f"{API}/cohorts?dataSourceId={ds}", headers=viewer)).status_code == 200
    assert (await client.patch(f"{API}/cohorts/dc1", headers=viewer, json={"name": "Y"})).status_code == 403
    assert (await client.delete(f"{API}/cohorts/dc1", headers=viewer)).status_code == 403
    assert (await _db_cohort(client, viewer, ds, cid="dc2")).status_code == 403

    assert (await client.get(f"{API}/cohorts/dc1", headers=outsider)).status_code == 403
    assert (await client.get(f"{API}/cohorts", headers=outsider)).json() == []
    assert [c["id"] for c in (await client.get(f"{API}/cohorts", headers=viewer)).json()] == ["dc1"]


async def test_deleting_the_database_deletes_its_cohorts(client):
    headers = await _admin_headers(client)
    _, ds = await _database(client, headers)
    await _db_cohort(client, headers, ds)
    assert (await client.delete(f"{API}/data-sources/{ds}", headers=headers)).status_code in (200, 204)
    assert (await client.get(f"{API}/cohorts/dc1", headers=headers)).status_code == 404


async def test_database_tree_carries_its_cohorts_without_patient_ids(client, db):
    import json

    from app.models.data_source import DataSource
    from app.services.workspace_export_assemble import build_database_tree

    headers = await _admin_headers(client)
    _, ds = await _database(client, headers)
    await _db_cohort(client, headers, ds, materialization={"ids": ["42"], "patientIds": ["42"]})
    await client.patch(f"{API}/cohorts/dc1", headers=headers, json={"resultCount": 1})

    tree = await build_database_tree(db, await db.get(DataSource, ds))
    exported = json.loads(tree["cohorts/adults.json"])
    assert exported["name"] == "Adults" and exported["level"] == "patient"
    for leaked in ("materialization", "resultCount", "attrition", "id", "ownerDataSourceId",
                   "dataSourceId", "dataSourceRef", "projectUid"):
        assert leaked not in exported
