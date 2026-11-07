"""A cohort's stored custom SQL, written by someone else, runs under a user's own
login to an external database only once that user accepted exactly that text.
A file database is the same for every member, so it asks for nothing."""

from app.models.data_source import DataSource
from tests.test_database_binding import (
    MEMBERSHIP,
    _database,
    _member,
    _with_person,
    _workspace,
)
from tests.test_ide_files import _admin_headers

API = "/api/v1"
CUSTOM_SQL = "SELECT person_id FROM person"


async def _external(db, ws: str) -> str:
    source = DataSource(
        workspace_id=ws, alias="pg", name={"en": "PG"}, source_type="database",
        connection_config={"engine": "postgresql", "host": "h", "port": 5432, "database": "omop"},
    )
    db.add(source)
    await db.commit()
    await db.refresh(source)
    return source.id


async def _project_with_cohort(client, author, ws: str, source: str) -> str:
    uid = (await client.post(f"{API}/projects", headers=author, json={
        "name": {"en": "P"}, "workspaceId": ws, "linkedDataSourceIds": [source],
    })).json()["uid"]
    r = await client.post(f"{API}/cohorts", headers=author, json={
        "id": "c1", "projectUid": uid, "name": {"en": "C"}, "level": "patient",
        "dataSourceId": source, "customSql": CUSTOM_SQL,
    })
    assert r.status_code == 201, r.text
    return uid


def _refusal_code(response) -> str | None:
    detail = response.json().get("detail")
    return detail.get("code") if isinstance(detail, dict) else None


async def test_freezing_a_colleagues_custom_sql_on_an_external_database_waits_for_acceptance(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    source = await _external(db, ws)
    author = await _member(client, db, ws, "author")
    freezer = await _member(client, db, ws, "freezer")
    await _project_with_cohort(client, author, ws, source)

    refused = await client.post(f"{API}/cohorts/c1/materialize", headers=freezer, json={"membershipSql": MEMBERSHIP})
    assert refused.status_code == 428, refused.text
    assert _refusal_code(refused) == "code_acceptance_required"
    assert (await client.get(f"{API}/cohorts/c1", headers=author)).json()["materialization"] is None

    accepted = await client.post(f"{API}/code-acceptances", headers=freezer, json={"codes": [CUSTOM_SQL]})
    assert accepted.status_code == 204, accepted.text
    after = await client.post(f"{API}/cohorts/c1/materialize", headers=freezer, json={"membershipSql": MEMBERSHIP})
    assert _refusal_code(after) != "code_acceptance_required", after.text


async def test_freezing_custom_sql_on_a_file_database_asks_for_nothing(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    source = await _database(client, admin, ws, "local")
    await _with_person(client, admin, source)
    author = await _member(client, db, ws, "author")
    freezer = await _member(client, db, ws, "freezer")
    await _project_with_cohort(client, author, ws, source)

    frozen = await client.post(f"{API}/cohorts/c1/materialize", headers=freezer, json={"membershipSql": MEMBERSHIP})
    assert frozen.status_code == 200, frozen.text
    assert frozen.json()["materialization"]["count"] == 2
