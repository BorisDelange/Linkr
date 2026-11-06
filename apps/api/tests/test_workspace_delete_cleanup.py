"""Deleting a workspace removes every patient-bearing file and cache it owns, and
a new database can never inherit on-disk state from a deleted one with the same id."""

import duckdb
from sqlalchemy import select

from app.core.security import hash_password
from app.models.job import Job
from app.models.stats_cache import StatsCache
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.services import stats_cache_service
from app.services.data import concept_cache_fs, managed_db, query_jobs
from tests.test_ide_files import _admin_headers

API = "/api/v1"
DB_ID = "demo-omop"


async def _workspace(client, headers) -> str:
    return (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]


async def _create_source(client, headers, ws: str, source_id: str = DB_ID, **config):
    return await client.post(f"{API}/data-sources", headers=headers, json={
        "id": source_id, "workspaceId": ws, "alias": "src", "name": {"en": "src"}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", **config},
    })


async def _managed_with_rows(client, headers, ws: str, source_id: str = DB_ID) -> None:
    created = await _create_source(client, headers, ws, source_id, managed=True)
    assert created.status_code == 201, created.text
    r = await client.post(f"{API}/data-sources/{source_id}/create-from-ddl", headers=headers,
                          json={"ddl": "CREATE TABLE person (person_id BIGINT, secret VARCHAR);"})
    assert r.status_code == 200, r.text
    con = duckdb.connect(str(managed_db.path_for(source_id)))
    con.execute("INSERT INTO person VALUES (1, 'dummy-row-A')")
    con.close()


async def _member_of_other_workspace(client, db, admin) -> tuple[str, dict]:
    other = await _workspace(client, admin)
    user = User(username="bob", password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(user)
    await db.flush()
    db.add(WorkspaceMember(workspace_id=other, user_id=user.id, role="editor"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": "bob", "password": "pw-for-tests-only"})
    return other, {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_deleting_a_workspace_removes_its_managed_databases_and_caches(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    await _managed_with_rows(client, admin, ws)
    concept_list = concept_cache_fs.cache_path(DB_ID)
    concept_list.write_bytes(b"dummy")
    run = concept_list.with_name(f"{DB_ID}.run")
    run.mkdir()
    await stats_cache_service.save(db, "database", DB_ID, "2026-01-01T00:00:00Z", {"n": 3})

    assert (await client.delete(f"{API}/workspaces/{ws}", headers=admin)).status_code == 204

    assert not managed_db.path_for(DB_ID).exists()
    assert not concept_list.exists()
    assert not run.exists()
    left = (await db.execute(select(StatsCache).where(StatsCache.cache_key == DB_ID))).scalars().all()
    assert left == []


async def test_deleting_a_workspace_removes_results_kept_for_its_jobs_and_entities(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    catalog = (await client.post(f"{API}/data-catalogs", headers=admin, json={
        "id": "cat-1", "workspaceId": ws, "name": {"en": "c"},
    })).json()["id"]
    await stats_cache_service.save(db, "catalog", catalog, "2026-01-01T00:00:00Z", {"n": 3})
    admin_id = (await db.execute(select(User.id).where(User.username == "admin"))).scalar_one()
    job = Job(workspace_id=ws, user_id=admin_id, kind="query")
    db.add(job)
    await db.commit()
    kept = query_jobs.results_dir(job.id)
    kept.mkdir(parents=True)
    (kept / "rows.json").write_text('{"rows": []}')

    assert (await client.delete(f"{API}/workspaces/{ws}", headers=admin)).status_code == 204

    assert not kept.exists()
    left = (await db.execute(select(StatsCache).where(StatsCache.cache_key == catalog))).scalars().all()
    assert left == []


async def test_a_new_database_never_opens_a_file_left_under_its_id(client, db, seed_roles):
    admin = await _admin_headers(client)
    other_ws, bob = await _member_of_other_workspace(client, db, admin)
    left_behind = managed_db.path_for(DB_ID)
    con = duckdb.connect(str(left_behind))
    con.execute("CREATE TABLE person AS SELECT 'dummy-row-A' AS secret")
    con.close()

    refused = await _create_source(client, bob, other_ws, managed=True)
    assert refused.status_code == 409, refused.text

    plain = await _create_source(client, bob, other_ws)
    assert plain.status_code == 201, plain.text
    switched = await client.patch(f"{API}/data-sources/{DB_ID}", headers=bob, json={
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })
    assert switched.status_code == 409, switched.text
    answer = await client.post(f"{API}/data-sources/{DB_ID}/query", headers=bob, json={"sql": "SELECT * FROM person"})
    assert "dummy-row-A" not in answer.text


async def test_a_new_database_starts_without_the_caches_of_a_deleted_one(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    concept_list = concept_cache_fs.cache_path(DB_ID)
    concept_list.write_bytes(b"dummy")
    await stats_cache_service.save(db, "database", DB_ID, "2026-01-01T00:00:00Z", {"n": 3})

    created = await _create_source(client, admin, ws)
    assert created.status_code == 201, created.text

    assert not concept_list.exists()
    left = (await db.execute(select(StatsCache).where(StatsCache.cache_key == DB_ID))).scalars().all()
    assert left == []


async def test_a_managed_database_builds_and_rebuilds_on_its_own_file(client, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    await _managed_with_rows(client, admin, ws)

    rebuilt = await client.post(f"{API}/data-sources/{DB_ID}/create-from-ddl", headers=admin,
                                json={"ddl": "CREATE TABLE person (person_id BIGINT);"})
    assert rebuilt.status_code == 200, rebuilt.text

    resaved = await client.patch(f"{API}/data-sources/{DB_ID}", headers=admin, json={
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })
    assert resaved.status_code == 200, resaved.text


async def test_a_plain_database_can_be_built_into_a_managed_one(client, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    assert (await _create_source(client, admin, ws, inMemory=True)).status_code == 201

    built = await client.post(f"{API}/data-sources/{DB_ID}/create-from-ddl", headers=admin,
                              json={"ddl": "CREATE TABLE person (person_id BIGINT);"})
    assert built.status_code == 200, built.text
    assert built.json()["connectionConfig"]["managed"] is True


async def test_the_refusal_for_a_file_left_behind_says_it_clears_on_its_own(client):
    from app.services.data import managed_db

    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    token = (await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    path = managed_db.path_for("leftover-id")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"dummy")

    r = await client.post(f"{API}/data-sources", headers=headers, json={
        "id": "leftover-id", "workspaceId": ws, "alias": "d", "name": "D", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "database_file_left_behind"
    assert "deleted database" in detail["message"] and "hour" in detail["message"] and "automatically" in detail["message"]
