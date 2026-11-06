"""SQL stored in a database's schema mapping runs under each reader's own login:
on a database with per-user logins, only an owner adds any."""

from sqlalchemy import select

from app.core.security import hash_password
from app.models.user import User
from app.services import code_acceptance_service
from app.services.data_source_service import free_sql_fragments

API = "/api/v1"
PG = {"engine": "postgresql", "host": "h", "database": "omop"}
MAPPING = {"formatVersion": 2, "patient": {"from": {"table": "person", "alias": "p"}, "fields": {"patient_id": "p.person_id"}}}
CUSTOM = {**MAPPING, "visit": {"customSql": "SELECT 1"}}


async def _headers(client, username):
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _workspace(client, db):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    admin = await _headers(client, "admin")
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    bob = User(username="bob", password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(bob)
    await db.commit()
    await db.refresh(bob)
    r = await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": bob.id, "role": "editor"})
    assert r.status_code < 300
    return admin, await _headers(client, "bob"), ws


async def _source(client, headers, ws, config=PG, mapping=None):
    return await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "src", "name": "Src", "sourceType": "database",
        "connectionConfig": config, "schemaMapping": mapping,
    })


def test_every_kind_of_free_sql_is_found():
    mapping = {
        "patient": {"where": "a = 1", "fields": {"x": {"expr": "b + 1"}, "y": {"value": "lit"}, "z": "p.z"}},
        "events": [{"label": "e", "customSql": "SELECT 2", "fields": {}}],
    }
    assert free_sql_fragments(mapping) == {"a = 1", "b + 1", "SELECT 2"}
    assert free_sql_fragments(None) == set()


async def test_an_editor_cannot_add_free_sql_to_a_database_with_per_user_logins(client, db):
    admin, bob, ws = await _workspace(client, db)
    source = (await _source(client, admin, ws, mapping=MAPPING)).json()["id"]
    for body in ({"schemaMapping": CUSTOM}, {"schemaOverrides": {"visit": {"customSql": "SELECT 1"}}}):
        r = await client.patch(f"{API}/data-sources/{source}", headers=bob, json=body)
        assert r.status_code == 403, body
    assert (await _source(client, bob, ws, mapping=CUSTOM)).status_code == 403


async def test_an_editor_keeps_editing_the_rest_of_the_mapping(client, db):
    admin, bob, ws = await _workspace(client, db)
    source = (await _source(client, admin, ws, mapping=CUSTOM)).json()["id"]
    edited = {**CUSTOM, "patient": {**MAPPING["patient"], "fields": {"patient_id": "p.id"}}}
    r = await client.patch(f"{API}/data-sources/{source}", headers=bob, json={"schemaMapping": edited})
    assert r.status_code == 200
    r = await client.patch(f"{API}/data-sources/{source}", headers=bob, json={"schemaMapping": MAPPING})
    assert r.status_code == 200


async def test_an_owner_may_add_it(client, db):
    admin, _, ws = await _workspace(client, db)
    source = (await _source(client, admin, ws, mapping=MAPPING)).json()["id"]
    r = await client.patch(f"{API}/data-sources/{source}", headers=admin, json={"schemaMapping": CUSTOM})
    assert r.status_code == 200


async def test_a_file_database_has_no_logins_to_protect(client, db, tmp_path):
    _, bob, ws = await _workspace(client, db)
    r = await _source(client, bob, ws, config={"engine": "duckdb"}, mapping=CUSTOM)
    assert r.status_code < 300, r.text


async def test_moving_a_file_database_to_a_server_counts_what_it_holds(client, db):
    _, bob, ws = await _workspace(client, db)
    source = (await _source(client, bob, ws, config={"engine": "duckdb"}, mapping=CUSTOM)).json()["id"]
    r = await client.patch(f"{API}/data-sources/{source}", headers=bob, json={"connectionConfig": PG})
    assert r.status_code == 403


async def _unaccepted(client, headers, source):
    return (await client.get(f"{API}/data-sources/{source}", headers=headers)).json()["unacceptedFreeSql"]


async def test_each_reader_has_to_accept_the_sql_itself(client, db):
    admin, bob, ws = await _workspace(client, db)
    source = (await _source(client, admin, ws, mapping=CUSTOM)).json()["id"]
    assert await _unaccepted(client, admin, source) == ["SELECT 1"]
    assert await _unaccepted(client, bob, source) == ["SELECT 1"]

    user = await db.scalar(select(User).where(User.username == "bob"))
    await code_acceptance_service.accept(db, user, ["SELECT 1"])
    assert await _unaccepted(client, bob, source) == []
    assert await _unaccepted(client, admin, source) == ["SELECT 1"]


async def test_changed_sql_and_sql_from_overrides_ask_again(client, db):
    admin, bob, ws = await _workspace(client, db)
    source = (await _source(client, admin, ws, mapping=CUSTOM)).json()["id"]
    user = await db.scalar(select(User).where(User.username == "bob"))
    await code_acceptance_service.accept(db, user, ["SELECT 1"])
    r = await client.patch(f"{API}/data-sources/{source}", headers=admin, json={"schemaOverrides": {"relations": {"visit": {"where": "a = 2"}}}})
    assert r.status_code == 200
    assert await _unaccepted(client, bob, source) == ["a = 2"]


async def test_the_list_says_it_too_and_a_file_database_asks_nothing(client, db):
    admin, _, ws = await _workspace(client, db)
    pg = (await _source(client, admin, ws, mapping=CUSTOM)).json()["id"]
    file_db = (await client.post(f"{API}/data-sources", headers=admin, json={
        "workspaceId": ws, "alias": "f", "name": "F", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"}, "schemaMapping": CUSTOM,
    })).json()["id"]
    listed = (await client.get(f"{API}/data-sources", headers=admin, params={"workspaceId": ws})).json()
    by_id = {row["id"]: row["unacceptedFreeSql"] for row in listed}
    assert by_id[pg] == ["SELECT 1"]
    assert by_id[file_db] == []


async def test_counts_made_without_the_held_back_relations_are_not_stored(client, db):
    admin, bob, ws = await _workspace(client, db)
    source = (await _source(client, admin, ws, mapping=CUSTOM)).json()["id"]
    r = await client.patch(f"{API}/data-sources/{source}", headers=bob, json={"stats": {"patientCount": 3}, "alias": "renamed"})
    assert r.status_code == 200
    assert r.json()["stats"] != {"patientCount": 3}
    assert r.json()["alias"] == "renamed"

    user = await db.scalar(select(User).where(User.username == "bob"))
    await code_acceptance_service.accept(db, user, ["SELECT 1"])
    r = await client.patch(f"{API}/data-sources/{source}", headers=bob, json={"stats": {"patientCount": 3}})
    assert r.json()["stats"] == {"patientCount": 3}
