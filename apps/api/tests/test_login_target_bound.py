"""A login resolved for where a database pointed is never sent to where it
points after: work waiting while the database is re-pointed asks again."""

import pytest

from app.models.data_source import DataSource
from app.schemas.data_source import DataSourceUpdate
from app.services import data_source_service
from app.services import database_credential_service as creds
from app.services.data import db_connect, query_jobs
from tests.test_database_credentials import _user

PG = {"engine": "postgresql", "host": "db.internal", "port": 5432, "database": "omop", "sslmode": "require"}


@pytest.fixture(autouse=True)
def _no_session_logins():
    yield
    with creds._session_lock:
        creds._session.clear()


@pytest.fixture
def sent(monkeypatch):
    calls: list[dict] = []

    def record(config, password, *args, **kwargs):
        calls.append({"host": config.get("host"), "user": config.get("username"), "password": password})
        return []

    monkeypatch.setattr(db_connect, "query_external", record)
    return calls


async def _source(db) -> DataSource:
    source = DataSource(alias="pg", name={"en": "PG"}, source_type="database", connection_config=dict(PG))
    db.add(source)
    await db.commit()
    await db.refresh(source)
    return source


async def _resolved(db, remember: bool):
    source = await _source(db)
    reader = await _user(db, "reader")
    await creds.save(db, source, reader.id, "reader_login", "dummy-reader-password", remember=remember)
    return source, await creds.resolve_login(db, source, reader.id)


async def _repoint(db, source: DataSource, **change) -> DataSource:
    source_id = source.id
    await data_source_service.update(db, source, DataSourceUpdate(connection_config={**PG, **change}))
    db.expire_all()
    return await data_source_service.get(db, source_id)


@pytest.mark.parametrize("remember", [True, False])
@pytest.mark.parametrize("change", [{"host": "127.0.0.1"}, {"port": 6543}, {"sslmode": "disable"}, {"flightPort": 1}])
async def test_a_query_waiting_through_a_repoint_never_sends_the_login(db, sent, remember, change):
    source, login = await _resolved(db, remember)
    source_id = source.id
    fresh = await _repoint(db, source, **change)
    with pytest.raises(creds.CredentialRequired) as exc:
        await data_source_service.query(db, fresh, login, "SELECT 1")
    assert exc.value.status_code == 428 and exc.value.detail["dataSourceId"] == source_id
    assert sent == []


async def test_a_query_job_between_two_queries_never_sends_the_login(db, sent):
    source, login = await _resolved(db, remember=True)
    run = query_jobs.read_rows(login, pushdown=False)
    assert await run(db, source, query_jobs.JobQuery("a", "SELECT 1")) == []
    fresh = await _repoint(db, source, host="127.0.0.1")
    with pytest.raises(creds.CredentialRequired):
        await run(db, fresh, query_jobs.JobQuery("b", "SELECT 1"))
    assert [c["host"] for c in sent] == ["db.internal"]


async def test_a_login_opens_the_database_it_was_resolved_for(db, sent):
    source, login = await _resolved(db, remember=True)
    renamed = await data_source_service.update(db, source, DataSourceUpdate(name={"en": "renamed"}))
    await data_source_service.query(db, renamed, login, "SELECT 1")
    assert sent == [{"host": "db.internal", "user": "reader_login", "password": "dummy-reader-password"}]


async def test_no_path_opens_another_target_with_a_resolved_login(db):
    _, login = await _resolved(db, remember=True)
    assert creds.with_login(dict(PG), login)["username"] == "reader_login"
    with pytest.raises(creds.CredentialRequired):
        creds.with_login({**PG, "host": "elsewhere"}, login)
