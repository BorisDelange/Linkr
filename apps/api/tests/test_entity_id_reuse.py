"""State keyed by an entity's id goes with the entity: a later row under the same
id, in any workspace, starts empty."""

from sqlalchemy import select

from app.models.stats_cache import StatsCache
from app.services import stats_cache_service
from app.config import settings
from tests.test_ide_files import _admin_headers
from tests.test_workspace_delete_cleanup import _create_source, _member_of_other_workspace, _workspace

API = "/api/v1"


async def _attach(client, headers, owner_type: str, owner_id: str, att_id: str = "att-1"):
    r = await client.post(
        f"{API}/readme-attachments", headers=headers, content=b"dummy attachment",
        params={"id": att_id, "fileName": "notes.txt", "ownerType": owner_type, "ownerId": owner_id},
    )
    assert r.status_code == 201, r.text


async def _listed(client, headers, owner_type: str, owner_id: str):
    return await client.get(
        f"{API}/readme-attachments", headers=headers, params={"ownerType": owner_type, "ownerId": owner_id},
    )


async def test_a_database_recreated_under_its_id_does_not_read_its_attachments(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    other_ws, bob = await _member_of_other_workspace(client, db, admin)
    assert (await _create_source(client, admin, ws, "ds-reused")).status_code == 201
    await _attach(client, admin, "data-source", "ds-reused")
    assert (await client.delete(f"{API}/data-sources/ds-reused", headers=admin)).status_code == 204

    assert (await _create_source(client, bob, other_ws, "ds-reused")).status_code == 201

    listed = await _listed(client, bob, "data-source", "ds-reused")
    assert listed.status_code == 200 and listed.json() == []
    assert (await client.get(f"{API}/readme-attachments/att-1/blob", headers=bob)).status_code == 404


async def test_deleting_a_database_removes_its_attachments_and_versioning_tree(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    assert (await _create_source(client, admin, ws, "ds-1")).status_code == 201
    await _attach(client, admin, "data-source", "ds-1")
    tree = settings.data_path / "databases" / "ds-1"
    tree.mkdir(parents=True)

    assert (await client.delete(f"{API}/data-sources/ds-1", headers=admin)).status_code == 204

    assert not tree.exists()
    assert (await client.get(f"{API}/readme-attachments/att-1/blob", headers=admin)).status_code == 404


async def test_a_database_created_over_attachments_left_earlier_starts_without_them(client, db, seed_roles):
    from app.services import attachment_service

    admin = await _admin_headers(client)
    other_ws, bob = await _member_of_other_workspace(client, db, admin)
    await attachment_service.create_readme(
        db, id="left", owner_type="data-source", owner_id="ds-left", workspace_id=None,
        file_name="n.txt", mime_type="", created_at=None, data=b"dummy",
    )

    assert (await _create_source(client, bob, other_ws, "ds-left")).status_code == 201

    assert (await _listed(client, bob, "data-source", "ds-left")).json() == []


async def _scoped(db, scope: str, key: str):
    return (await db.execute(select(StatsCache).where(StatsCache.scope == scope, StatsCache.cache_key == key))).scalars().all()


async def test_a_catalog_recreated_under_its_id_does_not_read_its_cached_results(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    other_ws, bob = await _member_of_other_workspace(client, db, admin)
    body = {"id": "cat-reused", "name": {"en": "c"}}
    assert (await client.post(f"{API}/data-catalogs", headers=admin, json={**body, "workspaceId": ws})).status_code == 201
    await stats_cache_service.save(db, "catalog", "cat-reused", "2026-01-01T00:00:00Z", {"rows": [1]})

    assert (await client.delete(f"{API}/data-catalogs/cat-reused", headers=admin)).status_code == 204
    assert await _scoped(db, "catalog", "cat-reused") == []

    await stats_cache_service.save(db, "catalog", "cat-reused", "2026-01-01T00:00:00Z", {"rows": [2]})
    assert (await client.post(f"{API}/data-catalogs", headers=bob, json={**body, "workspaceId": other_ws})).status_code == 201
    assert await _scoped(db, "catalog", "cat-reused") == []


async def test_a_pipeline_recreated_under_its_id_does_not_read_its_cached_quality(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    body = {"id": "etl-reused", "name": {"en": "p"}}
    assert (await client.post(f"{API}/etl-pipelines", headers=admin, json={**body, "workspaceId": ws})).status_code == 201
    await stats_cache_service.save(db, "etl-quality", "etl-reused", "2026-01-01T00:00:00Z", {"rows": [1]})

    assert (await client.delete(f"{API}/etl-pipelines/etl-reused", headers=admin)).status_code == 204
    assert await _scoped(db, "etl-quality", "etl-reused") == []

    await stats_cache_service.save(db, "etl-quality", "etl-reused", "2026-01-01T00:00:00Z", {"rows": [2]})
    assert (await client.post(f"{API}/etl-pipelines", headers=admin, json={**body, "workspaceId": ws})).status_code == 201
    assert await _scoped(db, "etl-quality", "etl-reused") == []


async def test_deleting_a_workspace_removes_the_versioning_trees_of_its_entities(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    created = {
        "data-catalogs": ("data-catalogs", {"id": "e-cat", "name": {"en": "c"}}),
        "etl-pipelines": ("etl-pipelines", {"id": "e-etl", "name": {"en": "p"}}),
        "dq-rule-sets": ("dq-rule-sets", {"id": "e-dq", "name": {"en": "d"}}),
        "sql-collections": ("sql-script-collections", {"id": "e-sql", "name": {"en": "s"}}),
    }
    trees = []
    for kind, (route, body) in created.items():
        r = await client.post(f"{API}/{route}", headers=admin, json={**body, "workspaceId": ws})
        assert r.status_code == 201, (route, r.text)
        tree = settings.data_path / kind / body["id"]
        tree.mkdir(parents=True)
        trees.append(tree)

    assert (await client.delete(f"{API}/workspaces/{ws}", headers=admin)).status_code == 204

    assert [t for t in trees if t.exists()] == []


async def test_a_workspace_delete_keeps_the_versioning_trees_of_another_workspace(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws, keep = await _workspace(client, admin), await _workspace(client, admin)
    r = await client.post(f"{API}/data-catalogs", headers=admin, json={"id": "k-cat", "workspaceId": keep, "name": {"en": "c"}})
    assert r.status_code == 201
    tree = settings.data_path / "data-catalogs" / "k-cat"
    tree.mkdir(parents=True)

    assert (await client.delete(f"{API}/workspaces/{ws}", headers=admin)).status_code == 204

    assert tree.exists()


