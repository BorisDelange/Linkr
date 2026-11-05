"""A database's write login: the second account a cohort derivation writes a SQL
Server, Doris or Oracle database with — kept apart from the user's read login,
which those engines check read-only at every attach."""

import pytest
from sqlalchemy import select

from app.core.security import hash_password
from app.models.data_source import DataSource
from app.models.database_credential import DatabaseCredential
from app.models.user import User
from app.services import cohort_derive_service, database_credential_service as creds
from app.services.database_credential_service import READ, WRITE, CredentialRequired

API = "/api/v1"


@pytest.fixture(autouse=True)
def _no_session_logins():
    yield
    with creds._session_lock:
        creds._session.clear()


async def _user(db, username: str) -> User:
    user = User(username=username, password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _mssql(db, **config) -> DataSource:
    source = DataSource(
        alias="ms", name={"en": "MS"}, source_type="database",
        connection_config={"engine": "sqlserver", "host": "h", "port": 1433, "database": "omop", **config},
    )
    db.add(source)
    await db.commit()
    await db.refresh(source)
    return source


async def test_a_write_login_is_kept_apart_from_the_read_login(db):
    source = await _mssql(db, allowWrites=True)
    alice = await _user(db, "alice")
    await creds.save(db, source, alice.id, "alice_ro", "pw-r", remember=True)
    with pytest.raises(CredentialRequired) as exc:
        await creds.resolve_login(db, source, alice.id, WRITE)
    assert exc.value.detail["purpose"] == WRITE

    await creds.save(db, source, alice.id, "alice_rw", "pw-w", remember=True, purpose=WRITE)
    read, write = await creds.resolve_login(db, source, alice.id), await creds.resolve_login(db, source, alice.id, WRITE)
    assert (read.username, read.password) == ("alice_ro", "pw-r")
    assert (write.username, write.password) == ("alice_rw", "pw-w")
    assert write.principal != read.principal

    # Forgetting one leaves the other.
    await creds.forget(db, source, alice.id, WRITE)
    assert (await creds.resolve_login(db, source, alice.id)).username == "alice_ro"
    assert not (await creds.status_for(db, source, alice.id, WRITE))["hasLogin"]


async def test_a_read_secret_never_opens_as_a_write_login(db):
    source = await _mssql(db, allowWrites=True)
    alice = await _user(db, "alice")
    await creds.save(db, source, alice.id, "alice_ro", "pw-r", remember=True)
    row = (await db.execute(select(DatabaseCredential))).scalar_one()
    db.add(DatabaseCredential(user_id=alice.id, data_source_id=source.id, purpose=WRITE, username="x", secret=row.secret))
    await db.commit()
    with pytest.raises(CredentialRequired):
        await creds.resolve_login(db, source, alice.id, WRITE)


async def test_which_login_a_derivation_writes_with(db):
    assert cohort_derive_service.write_purpose(await _mssql(db, allowWrites=True)) == WRITE
    pg = DataSource(alias="pg", name={"en": "PG"}, source_type="database",
                    connection_config={"engine": "postgresql", "host": "h", "allowWrites": True})
    assert cohort_derive_service.write_purpose(pg) == READ
    assert cohort_derive_service.takes_write_login(await _mssql(db, allowWrites=True))
    assert not cohort_derive_service.takes_write_login(await _mssql(db))
    assert not cohort_derive_service.takes_write_login(pg)


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _external(client, headers, ws, alias, **config) -> str:
    return (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": alias, "name": alias, "sourceType": "database",
        "connectionConfig": {"engine": "sqlserver", "host": "127.0.0.1", "port": 1433, "database": "omop", **config},
        "schemaMapping": {"presetId": "omop", "patientTable": {"table": "person", "idColumn": "person_id"}},
    })).json()["id"]


async def test_a_write_login_is_saved_and_tested_writable(client, monkeypatch):
    tested = []

    async def fake_test(config, password):
        tested.append((config["username"], password))
        return True, None

    monkeypatch.setattr(cohort_derive_service, "test_write_login", fake_test)
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    closed = await _external(client, headers, ws, "closed")
    open_ = await _external(client, headers, ws, "open", allowWrites=True)
    body = {"username": "linkr_rw", "password": "pw-w", "remember": True}

    assert (await client.put(f"{API}/data-sources/{closed}/my-login?purpose=write", headers=headers, json=body)).status_code == 400
    assert (await client.put(f"{API}/data-sources/{open_}/my-login?purpose=admin", headers=headers, json=body)).status_code == 400
    r = await client.put(f"{API}/data-sources/{open_}/my-login?purpose=write", headers=headers, json=body)
    assert r.status_code == 200 and r.json()["hasLogin"] and r.json()["purpose"] == "write"
    assert tested == [("linkr_rw", "pw-w")]
    # The read login is still the one to enter.
    assert not (await client.get(f"{API}/data-sources/{open_}/my-login", headers=headers)).json()["hasLogin"]


async def test_a_derivation_into_sql_server_asks_for_the_write_login(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "src", "name": "src", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True},
        "schemaMapping": {"presetId": "omop", "patientTable": {"table": "person", "idColumn": "person_id"}},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{src}/create-from-ddl", headers=headers, json={"ddl": "CREATE TABLE person (person_id BIGINT);"})
    assert r.status_code == 200, r.text
    target = await _external(client, headers, ws, "mssql", allowWrites=True)
    r = await client.post(f"{API}/data-sources/{src}/derive", headers=headers, json={
        "membershipSql": "SELECT person_id AS id, person_id AS patient_id FROM person", "level": "patient",
        "target": {"kind": "schema", "dataSourceId": target, "schemaName": "cohort_a"},
    })
    assert r.status_code == 428, r.text
    assert r.json()["detail"]["purpose"] == "write" and r.json()["detail"]["dataSourceId"] == target


# Opt-in, against live databases: the variables of test_cohort_derive_minimization's
# live tests, whose login is used as the write login here.
LIVE = {"sqlserver": "LINKR_TEST_MSSQL_DSN", "doris": "LINKR_TEST_DORIS_DSN", "oracle": "LINKR_TEST_ORACLE_DSN"}


@pytest.mark.parametrize("kind", list(LIVE))
async def test_a_derivation_writes_with_the_write_login_through_the_api(kind, client):
    import contextlib
    import json
    import os

    import duckdb

    from app.services.data import db_connect, managed_db
    from app.services.execution import jobs

    if not os.environ.get(LIVE[kind]):
        pytest.skip(f"set {LIVE[kind]} to derive into a live {kind} database")
    live = json.loads(os.environ[LIVE[kind]])
    schema = live.pop("derivedSchema", f"cohort_api{os.getpid()}")
    live.pop("correspondenceSchema", None)
    username, password = live.pop("username"), live.pop("password")
    if kind == "sqlserver":
        from app.duckdb_extensions import install

        install(db_connect._ext_dir(), community=True)

    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    mapping = {"presetId": "omop", "patientTable": {"table": "person", "idColumn": "person_id"}}
    src = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "src", "name": "src", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True}, "schemaMapping": mapping,
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{src}/create-from-ddl", headers=headers,
                          json={"ddl": "CREATE TABLE person (person_id BIGINT, birth_datetime TIMESTAMP);"})
    assert r.status_code == 200, r.text
    con = duckdb.connect(str(managed_db.path_for(src)))
    con.execute("INSERT INTO person SELECT i, TIMESTAMP '1980-06-17' FROM range(1, 21) t(i)")
    con.close()
    target = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "live", "name": "live", "sourceType": "database",
        "connectionConfig": {**live, "allowWrites": True}, "schemaMapping": mapping,
    })).json()["id"]

    r = await client.put(f"{API}/data-sources/{target}/my-login?purpose=write", headers=headers,
                         json={"username": username, "password": password, "remember": True})
    assert r.status_code == 200, r.text
    payload = {
        "membershipSql": "SELECT person_id AS id, person_id AS patient_id FROM person WHERE person_id <= 5",
        "level": "patient", "target": {"kind": "schema", "dataSourceId": target, "schemaName": schema},
        "pseudonymization": {"method": "hmac"},
    }
    try:
        r = await client.post(f"{API}/data-sources/{src}/derive", headers=headers, json=payload)
        assert r.status_code == 202, r.text
        job_id = r.json()["id"]
        if (task := jobs._tasks.get(job_id)) is not None:
            with contextlib.suppress(BaseException):
                await task
        job = next(j for j in (await client.get(f"{API}/workspaces/{ws}/jobs", headers=headers)).json() if j["id"] == job_id)
        assert job["status"] == "done", job
        assert {t["table"]: t["rows"] for t in job["result"]["tables"]} == {"person": 5}
    finally:
        from app.services.data import derive_writers
        from app.services.data.cohort_derive import _connect

        con = _connect()
        writer = derive_writers.writer_for(
            con, derive_writers.Destination("external", config={**live, "username": username}, password=password), "live",
        )
        try:
            writer.drop_schema(schema)
        finally:
            writer.close()
            con.close()
