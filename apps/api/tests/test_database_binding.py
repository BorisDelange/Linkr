"""An entity in a workspace is bound only to a database of that workspace, a
project links only databases of its workspace, a project cohort reads only a
database linked to its project, and results stored in a workspace come from that
workspace's data, whoever runs the entity."""

import duckdb
import pytest
from sqlalchemy import update

from app.core.security import hash_password
from app.models.cohort import Cohort
from app.models.data_catalog import DataCatalog
from app.models.dq_rule_set import DqRuleSet
from app.models.etl_pipeline import EtlFile, EtlPipeline
from app.models.project import Project
from app.models.role import Role
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.services.data import managed_db
from tests.test_ide_files import _admin_headers

API = "/api/v1"
UNKNOWN_ID = "11111111-1111-1111-1111-111111111111"
MEMBERSHIP = "SELECT person_id AS id, person_id AS patient_id FROM person"


async def _workspace(client, headers, name: str = "WS") -> str:
    return (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": name}})).json()["id"]


async def _database(client, headers, ws: str, alias: str, **fields) -> str:
    r = await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": alias, "name": {"en": alias}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True}, **fields,
    })
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, db, ws: str, username: str, role: str = "editor") -> dict:
    user = User(username=username, password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(user)
    await db.flush()
    db.add(WorkspaceMember(workspace_id=ws, user_id=user.id, role=role))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
async def world(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws_a, ws_b = await _workspace(client, admin, "A"), await _workspace(client, admin, "B")
    return {
        "admin": admin, "a": ws_a, "b": ws_b,
        "local": await _database(client, admin, ws_a, "local"),
        "foreign": await _database(client, admin, ws_b, "foreign"),
        "editor": await _member(client, db, ws_a, "editor-a"),
    }


# (collection route, creation body, the field carrying the database id)
ENTITIES = [
    ("dq-rule-sets", {"name": {"en": "r"}}, "dataSourceId"),
    ("data-catalogs", {"name": {"en": "c"}}, "dataSourceId"),
    ("etl-pipelines", {"name": {"en": "p"}}, "sourceDataSourceId"),
    ("etl-pipelines", {"name": {"en": "p"}}, "targetDataSourceId"),
    ("sql-script-collections", {"name": {"en": "s"}}, "defaultDataSourceId"),
    ("mapping-projects", {"name": {"en": "m"}, "sourceType": "database"}, "dataSourceId"),
]


@pytest.mark.parametrize("route,body,field", ENTITIES)
async def test_a_workspace_entity_is_bound_only_to_a_database_of_its_workspace(client, world, route, body, field):
    h, ws = world["editor"], world["a"]

    refused = await client.post(f"{API}/{route}", headers=h, json={
        "id": "e-refused", "workspaceId": ws, **body, field: world["foreign"],
    })
    assert refused.status_code == 400, refused.text

    created = await client.post(f"{API}/{route}", headers=h, json={"id": "e-1", "workspaceId": ws, **body})
    assert created.status_code == 201, created.text
    entity = created.json()["id"]

    repointed = await client.patch(f"{API}/{route}/{entity}", headers=h, json={field: world["foreign"]})
    assert repointed.status_code == 400, repointed.text
    stored = await client.get(f"{API}/{route}/{entity}", headers=h)
    assert stored.json().get(field) != world["foreign"]

    for allowed in (world["local"], UNKNOWN_ID, ""):
        r = await client.patch(f"{API}/{route}/{entity}", headers=h, json={field: allowed})
        assert r.status_code == 200, f"{allowed}: {r.text}"


async def test_a_pipeline_is_bound_only_to_a_mapping_project_of_its_workspace(client, world):
    h, admin = world["editor"], world["admin"]
    theirs = (await client.post(f"{API}/mapping-projects", headers=admin, json={
        "id": "mp-b", "workspaceId": world["b"], "name": {"en": "m"}, "sourceType": "file",
    })).json()["id"]
    ours = (await client.post(f"{API}/mapping-projects", headers=h, json={
        "id": "mp-a", "workspaceId": world["a"], "name": {"en": "m"}, "sourceType": "file",
    })).json()["id"]
    await client.post(f"{API}/etl-pipelines", headers=h, json={"id": "p1", "workspaceId": world["a"], "name": {"en": "p"}})

    assert (await client.patch(f"{API}/etl-pipelines/p1", headers=h, json={"mappingProjectId": theirs})).status_code == 400
    assert (await client.patch(f"{API}/etl-pipelines/p1", headers=h, json={"mappingProjectId": ours})).status_code == 200


async def test_binding_a_database_asks_the_right_to_read_it(client, db, world):
    db.add(Role(name="dq-only", scope="workspace", permissions=["data-quality:read", "data-quality:write"]))
    await db.commit()
    h = await _member(client, db, world["a"], "dq-author", role="dq-only")
    await client.post(f"{API}/dq-rule-sets", headers=h, json={"id": "r1", "workspaceId": world["a"], "name": {"en": "r"}})

    r = await client.patch(f"{API}/dq-rule-sets/r1", headers=h, json={"dataSourceId": world["local"]})
    assert r.status_code == 403, r.text


async def test_a_mapping_project_may_keep_a_vocabulary_reference_from_elsewhere(client, world):
    vocabulary = await _database(client, world["admin"], world["b"], "vocab", isVocabularyReference=True)
    h = world["editor"]
    await client.post(f"{API}/mapping-projects", headers=h, json={
        "id": "m1", "workspaceId": world["a"], "name": {"en": "m"}, "sourceType": "database",
    })

    kept = await client.patch(f"{API}/mapping-projects/m1", headers=h, json={"vocabularyDataSourceId": vocabulary})
    assert kept.status_code == 200, kept.text
    refused = await client.patch(f"{API}/mapping-projects/m1", headers=h, json={"vocabularyDataSourceId": world["foreign"]})
    assert refused.status_code == 400, refused.text


async def test_a_project_links_only_databases_of_its_workspace(client, world):
    h, ws = world["editor"], world["a"]
    db_a, db_b = world["local"], world["foreign"]

    refused = await client.post(f"{API}/projects", headers=world["admin"], json={
        "name": {"en": "P"}, "workspaceId": ws, "linkedDataSourceIds": [db_b],
    })
    assert refused.status_code == 400, refused.text

    uid = (await client.post(f"{API}/projects", headers=h, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    assert (await client.patch(f"{API}/projects/{uid}", headers=h, json={"linkedDataSourceIds": [db_b]})).status_code == 400
    linked = await client.patch(f"{API}/projects/{uid}", headers=h, json={"linkedDataSourceIds": [db_a]})
    assert linked.status_code == 200, linked.text
    assert linked.json()["linkedDataSourceIds"] == [db_a]


async def test_a_project_leaving_its_workspace_leaves_its_links_behind(client, world):
    admin = world["admin"]
    uid = (await client.post(f"{API}/projects", headers=admin, json={
        "name": {"en": "P"}, "workspaceId": world["a"], "linkedDataSourceIds": [world["local"]],
        "linkedDataSourceRefs": [{"entityId": "local"}],
    })).json()["uid"]

    moved = await client.patch(f"{API}/projects/{uid}", headers=admin, json={"workspaceId": world["b"]})
    assert moved.status_code == 200, moved.text
    assert moved.json()["linkedDataSourceIds"] == []
    assert moved.json()["linkedDataSourceRefs"] == []


async def test_a_links_refresh_tolerates_one_already_stored(client, db, world):
    h = world["editor"]
    uid = (await client.post(f"{API}/projects", headers=h, json={"name": {"en": "P"}, "workspaceId": world["a"]})).json()["uid"]
    (await db.get(Project, uid)).linked_data_source_ids = [world["foreign"]]
    await db.commit()

    kept = await client.patch(f"{API}/projects/{uid}", headers=h, json={
        "linkedDataSourceIds": [world["foreign"], world["local"]],
    })
    assert kept.status_code == 200, kept.text


async def _project(client, h, ws: str, *links: str) -> str:
    r = await client.post(f"{API}/projects", headers=h, json={
        "name": {"en": "P"}, "workspaceId": ws, "linkedDataSourceIds": list(links),
    })
    assert r.status_code == 201, r.text
    return r.json()["uid"]


async def test_a_project_cohort_is_bound_only_to_a_database_of_its_workspace(client, world):
    h = world["editor"]
    uid = await _project(client, h, world["a"], world["local"])
    body = {"name": {"en": "C"}, "level": "patient", "criteriaTree": {}, "projectUid": uid}

    refused = await client.post(f"{API}/cohorts", headers=h, json={**body, "id": "c0", "dataSourceId": world["foreign"]})
    assert refused.status_code == 400, refused.text

    assert (await client.post(f"{API}/cohorts", headers=h, json={**body, "id": "c1", "dataSourceId": world["local"]})).status_code == 201
    assert (await client.patch(f"{API}/cohorts/c1", headers=h, json={"dataSourceId": world["foreign"]})).status_code == 400
    resaved = await client.patch(f"{API}/cohorts/c1", headers=h, json={"dataSourceId": world["local"], "resultCount": 3})
    assert resaved.status_code == 200, resaved.text


@pytest.mark.parametrize("route,owner,field", [
    ("etl-files", ("etl-pipelines", "pipelineId"), "dataSourceId"),
    ("sql-script-files", ("sql-script-collections", "collectionId"), "dataSourceId"),
])
async def test_a_script_is_bound_only_to_a_database_of_its_owners_workspace(client, world, route, owner, field):
    h, ws = world["editor"], world["a"]
    collection, key = owner
    parent = (await client.post(f"{API}/{collection}", headers=h, json={
        "id": "owner-1", "workspaceId": ws, "name": {"en": "o"},
    })).json()["id"]
    node = {"id": "f1", key: parent, "name": "a.sql", "type": "file"}

    assert (await client.post(f"{API}/{route}", headers=h, json={**node, "id": "f0", field: world["foreign"]})).status_code == 400
    assert (await client.post(f"{API}/{route}", headers=h, json=node)).status_code == 201
    assert (await client.patch(f"{API}/{route}/f1", headers=h, json={field: world["foreign"]})).status_code == 400
    assert (await client.patch(f"{API}/{route}/f1", headers=h, json={field: world["local"]})).status_code == 200


async def test_a_patient_board_and_a_concept_list_are_bound_only_to_a_database_of_their_workspace(client, world):
    h = world["editor"]
    uid = await _project(client, h, world["a"], world["local"])
    board = {"name": {"en": "B"}, "projectUid": uid}
    concept_list = {"name": {"en": "L"}, "projectUid": uid}

    for route, body in (("patient-dashboards", board), ("concept-lists", concept_list)):
        refused = await client.post(f"{API}/{route}", headers=h, json={**body, "id": "x0", "dataSourceId": world["foreign"]})
        assert refused.status_code == 400, refused.text
        created = await client.post(f"{API}/{route}", headers=h, json={**body, "id": "x1", "dataSourceId": world["local"]})
        assert created.status_code == 201, created.text
        moved = await client.patch(f"{API}/{route}/x1", headers=h, json={"dataSourceId": world["foreign"]})
        assert moved.status_code == 400, moved.text


async def _with_person(client, admin, source_id: str) -> None:
    r = await client.post(f"{API}/data-sources/{source_id}/create-from-ddl", headers=admin,
                          json={"ddl": "CREATE TABLE person (person_id BIGINT);"})
    assert r.status_code == 200, r.text
    con = duckdb.connect(str(managed_db.path_for(source_id)))
    con.execute("INSERT INTO person VALUES (1), (2)")
    con.close()


async def test_a_frozen_cohort_reads_only_a_database_linked_to_its_project(client, db, world):
    admin = world["admin"]
    await _with_person(client, admin, world["foreign"])
    await _with_person(client, admin, world["local"])
    uid = await _project(client, admin, world["a"], world["local"])
    body = {"name": {"en": "C"}, "level": "patient", "criteriaTree": {}, "projectUid": uid}
    await client.post(f"{API}/cohorts", headers=admin, json={**body, "id": "c1", "dataSourceId": world["local"]})
    db.add(Cohort(id="c-stale", name={"en": "C"}, level="patient", criteria_tree={}, project_uid=uid,
                  data_source_id=world["foreign"]))
    await db.commit()

    for cohort, payload in (
        ("c-stale", {"membershipSql": MEMBERSHIP}),
        ("c1", {"membershipSql": MEMBERSHIP, "dataSourceId": world["foreign"]}),
    ):
        r = await client.post(f"{API}/cohorts/{cohort}/materialize", headers=admin, json=payload)
        assert r.status_code == 400, r.text
        assert (await client.get(f"{API}/cohorts/{cohort}", headers=admin)).json().get("materialization") is None

    frozen = await client.post(f"{API}/cohorts/c1/materialize", headers=admin, json={"membershipSql": MEMBERSHIP})
    assert frozen.status_code == 200, frozen.text
    assert frozen.json()["materialization"]["count"] == 2


async def test_a_run_of_a_database_of_another_workspace_is_not_stored_in_this_one(client, db, world):
    admin = world["admin"]
    db.add(DqRuleSet(id="r-stale", workspace_id=world["a"], name={"en": "r"}, data_source_id=world["foreign"]))
    db.add(DataCatalog(id="c-stale", workspace_id=world["a"], name={"en": "c"}, data_source_id=world["foreign"]))
    db.add(EtlPipeline(id="p-stale", workspace_id=world["a"], name={"en": "p"}, source_data_source_id=world["foreign"]))
    await db.commit()
    await client.post(f"{API}/dq-rule-sets", headers=admin, json={
        "id": "r-ok", "workspaceId": world["a"], "name": {"en": "r"}, "dataSourceId": world["local"],
    })
    run = {"startedAt": "2026-01-01T00:00:00Z", "status": "success"}

    refused = await client.post(f"{API}/dq-run-history", headers=admin, json={
        **run, "id": "run-1", "ruleSetId": "r-stale", "dataSourceId": world["foreign"],
    })
    assert refused.status_code == 409, refused.text
    claimed = await client.post(f"{API}/dq-run-history", headers=admin, json={
        **run, "id": "run-2", "ruleSetId": "r-ok", "dataSourceId": world["foreign"],
    })
    assert claimed.status_code == 409, claimed.text
    accepted = await client.post(f"{API}/dq-run-history", headers=admin, json={
        **run, "id": "run-3", "ruleSetId": "r-ok", "dataSourceId": world["local"],
    })
    assert accepted.status_code == 201, accepted.text

    assert (await client.patch(f"{API}/dq-rule-sets/r-stale", headers=admin, json={"lastScore": 42})).status_code == 409
    assert (await client.patch(f"{API}/dq-rule-sets/r-ok", headers=admin, json={"lastScore": 42})).status_code == 200

    cache = {"computedAt": "2026-01-01T00:00:00Z", "payload": {"n": 3}}
    assert (await client.put(f"{API}/data-catalogs/c-stale/results-cache", headers=admin, json=cache)).status_code == 409
    assert (await client.patch(f"{API}/data-catalogs/c-stale", headers=admin, json={"counts": {"n": 3}})).status_code == 409
    fixed = await client.patch(f"{API}/data-catalogs/c-stale", headers=admin, json={"dataSourceId": world["local"]})
    assert fixed.status_code == 200, fixed.text
    assert (await client.put(f"{API}/data-catalogs/c-stale/results-cache", headers=admin, json=cache)).status_code == 204

    etl_run = await client.post(f"{API}/etl-runs", headers=admin, json={"id": "e1", "pipelineId": "p-stale", "startedAt": "2026-01-01T00:00:00Z", "status": "running"})
    assert etl_run.status_code == 409, etl_run.text


@pytest.mark.parametrize("route", ["etl-run", "etl-jobs"])
async def test_an_etl_run_attaches_only_databases_of_its_targets_workspace(client, world, route):
    admin = world["admin"]
    await _with_person(client, admin, world["local"])
    body = {"sql": "SELECT 1", "label": "t", "roles": {"source": world["foreign"]}}

    r = await client.post(f"{API}/data-sources/{world['local']}/{route}", headers=admin, json=body)
    assert r.status_code == 400, r.text


async def test_an_etl_run_may_attach_a_vocabulary_reference_from_elsewhere(client, world):
    admin = world["admin"]
    await _with_person(client, admin, world["local"])
    vocabulary = await _database(client, admin, world["b"], "vocab", isVocabularyReference=True)
    await _with_person(client, admin, vocabulary)

    r = await client.post(f"{API}/data-sources/{world['local']}/etl-run", headers=admin, json={
        "sql": "SELECT 1 AS x", "roles": {"vocab": vocabulary},
    })
    assert r.status_code != 400, r.text


async def test_a_run_of_a_pipeline_whose_script_points_at_another_workspace_is_refused(client, db, world):
    admin = world["admin"]
    db.add(EtlPipeline(id="p-script", workspace_id=world["a"], name={"en": "p"}, target_data_source_id=world["local"]))
    await db.flush()
    db.add(EtlFile(id="f-stale", pipeline_id="p-script", name="a.sql", type="file", data_source_id=world["foreign"]))
    await db.commit()

    run = {"id": "e2", "pipelineId": "p-script", "startedAt": "2026-01-01T00:00:00Z", "status": "running"}
    assert (await client.post(f"{API}/etl-runs", headers=admin, json=run)).status_code == 409

    await db.execute(update(EtlFile).where(EtlFile.id == "f-stale").values(data_source_id=world["local"]))
    await db.commit()
    assert (await client.post(f"{API}/etl-runs", headers=admin, json=run)).status_code == 201
