import asyncio
import os

import pytest

from app.core.security import hash_password
from app.models.user import User
from app.services import blob_store
from app.services import data_source_service
from app.services.data_source_service import (
    connection_password,
    strip_secrets,
    test_connection as run_test_connection,
)

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


async def _workspace(client, headers) -> str:
    return (
        await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})
    ).json()["id"]


async def _upload(client, headers, data: bytes, name: str = "vocab.parquet") -> str:
    r = await client.post(
        f"{API}/uploads", headers=headers, json={"fileName": name, "totalChunks": 1}
    )
    uid = r.json()["uploadId"]
    await client.put(f"{API}/uploads/{uid}/chunk?index=0", headers=headers, content=data)
    return (await client.post(f"{API}/uploads/{uid}/complete", headers=headers)).json()["sha"]


def test_strip_secrets_removes_password_and_token():
    assert strip_secrets(
        {"engine": "postgresql", "host": "localhost", "password": "s3cr3t", "token": "t"}
    ) == {"engine": "postgresql", "host": "localhost"}
    assert strip_secrets(None) == {}


async def test_create_strips_password(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    body = {
        "workspaceId": ws,
        "alias": "pg",
        "name": "Local Postgres",
        "sourceType": "database",
        "connectionConfig": {
            "engine": "postgresql",
            "host": "localhost",
            "port": 5432,
            "database": "linkr",
            "username": "boris",
            "password": "s3cr3t",
        },
    }
    r = await client.post(f"{API}/data-sources", headers=headers, json=body)
    assert r.status_code == 201
    ds = r.json()
    # The password never round-trips — it was stripped before persistence.
    assert "password" not in ds["connectionConfig"]
    assert ds["connectionConfig"]["host"] == "localhost"

    fetched = (await client.get(f"{API}/data-sources/{ds['id']}", headers=headers)).json()
    assert "password" not in fetched["connectionConfig"]


async def test_password_encrypted_at_rest_and_recoverable(client, db):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "pg", "name": "PG", "sourceType": "database",
        "connectionConfig": {"engine": "postgresql", "host": "h", "password": "s3cr3t"},
    })).json()

    row = await data_source_service.get(db, ds["id"])
    # Stored ciphertext is neither empty nor the plaintext.
    assert row.connection_secret and "s3cr3t" not in row.connection_secret
    # And it decrypts back for opening a connection server-side.
    assert connection_password(row) == "s3cr3t"


async def test_update_without_password_keeps_secret(client, db):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "pg", "name": "PG", "sourceType": "database",
        "connectionConfig": {"engine": "postgresql", "host": "h", "password": "keep"},
    })).json()
    # Editing another field (no password in the config) must not wipe the secret.
    await client.patch(f"{API}/data-sources/{ds['id']}", headers=headers, json={
        "connectionConfig": {"engine": "postgresql", "host": "h2"},
    })
    row = await data_source_service.get(db, ds["id"])
    assert connection_password(row) == "keep"


async def test_retest_uses_stored_credentials(client):
    # Unreachable host → retest reports ok=False without the client sending a
    # password (it uses the stored, encrypted one).
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "pg", "name": "PG", "sourceType": "database",
        "connectionConfig": {
            "engine": "postgresql", "host": "127.0.0.1", "port": 59999,
            "database": "x", "username": "u", "password": "p",
        },
    })).json()
    r = await client.post(f"{API}/data-sources/{ds['id']}/retest", headers=headers)
    assert r.status_code == 200
    assert r.json()["ok"] is False and r.json()["error"]


async def test_duckdb_file_source_query_and_schema(client):
    # A DuckDB file uploaded to the server can be introspected and queried
    # server-side (no browser WASM) via /schema and /query.
    import tempfile
    from pathlib import Path

    import duckdb

    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "f", "name": "File DB", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })).json()

    # Build a real DuckDB file and upload it as the source's backing file.
    d = Path(tempfile.mkdtemp())
    fp = d / "db.duckdb"
    con = duckdb.connect(fp.as_posix())
    con.execute("CREATE TABLE person(person_id INT, gender TEXT)")
    con.execute("INSERT INTO person VALUES (1,'M'),(2,'F'),(3,'M')")
    con.close()
    sha = await _upload(client, headers, fp.read_bytes(), name="db.duckdb")
    await client.post(f"{API}/data-sources/files/import", headers=headers, json={
        "dataSourceId": ds["id"], "sha": sha, "fileName": "db.duckdb", "fileSize": fp.stat().st_size,
    })

    schema = (await client.get(f"{API}/data-sources/{ds['id']}/schema", headers=headers)).json()
    assert any(t["name"] == "person" for t in schema)

    r = await client.post(f"{API}/data-sources/{ds['id']}/query", headers=headers,
                          json={"sql": "SELECT COUNT(*) AS n FROM person"})
    assert r.status_code == 200
    assert r.json()["rows"] == [{"n": 3}]

    # Multi-statement CREATE VIEW + SELECT: the file is read-only, but views land
    # in the writable `memory` catalog so scripts with intermediate views work.
    r = await client.post(f"{API}/data-sources/{ds['id']}/query", headers=headers, json={
        "sql": "CREATE OR REPLACE VIEW males AS SELECT * FROM person WHERE gender='M';"
               " SELECT COUNT(*) AS n FROM males;",
    })
    assert r.status_code == 200
    assert r.json()["rows"] == [{"n": 2}]


async def test_query_unsupported_engine_is_400(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "d", "name": "D", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })).json()
    r = await client.post(f"{API}/data-sources/{ds['id']}/query", headers=headers,
                          json={"sql": "SELECT 1"})
    assert r.status_code == 400


async def test_update_strips_password(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "pg", "name": "PG", "sourceType": "database",
        "connectionConfig": {"engine": "postgresql", "host": "a"},
    })).json()
    r = await client.patch(f"{API}/data-sources/{ds['id']}", headers=headers, json={
        "connectionConfig": {"engine": "postgresql", "host": "b", "password": "leak"},
    })
    assert r.status_code == 200
    assert "password" not in r.json()["connectionConfig"]
    assert r.json()["connectionConfig"]["host"] == "b"


async def test_list_by_workspace(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "a", "name": "A", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })
    r = await client.get(f"{API}/data-sources?workspaceId={ws}", headers=headers)
    assert r.status_code == 200 and len(r.json()) == 1


async def test_file_import_dedup_and_cascade(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)

    async def _source(alias):
        return (await client.post(f"{API}/data-sources", headers=headers, json={
            "workspaceId": ws, "alias": alias, "name": alias, "sourceType": "database",
            "connectionConfig": {"engine": "duckdb"},
        })).json()["id"]

    src_a, src_b = await _source("a"), await _source("b")

    # The same bytes imported into two sources share one blob (dedup by sha).
    payload = b"PAR1_fake_parquet_bytes"
    sha = await _upload(client, headers, payload)
    fa = (await client.post(f"{API}/data-sources/files/import", headers=headers, json={
        "dataSourceId": src_a, "sha": sha, "fileName": "vocab.parquet", "fileSize": len(payload),
    })).json()
    fb = (await client.post(f"{API}/data-sources/files/import", headers=headers, json={
        "dataSourceId": src_b, "sha": sha, "fileName": "vocab.parquet", "fileSize": len(payload),
    })).json()
    assert fa["contentHash"] == fb["contentHash"] == sha
    assert blob_store.exists(sha)

    # Bytes are downloadable for the browser DuckDB mount path.
    r = await client.get(f"{API}/data-sources/files/{fa['id']}/blob", headers=headers)
    assert r.status_code == 200 and r.content == payload
    assert r.headers["x-file-name"] == "vocab.parquet"

    # Deleting source A must NOT free the blob — source B still references it.
    assert (await client.delete(f"{API}/data-sources/{src_a}", headers=headers)).status_code == 204
    assert blob_store.exists(sha)

    # Deleting the last referencing source frees the blob.
    assert (await client.delete(f"{API}/data-sources/{src_b}", headers=headers)).status_code == 204
    assert not blob_store.exists(sha)


async def test_files_listed_and_deletable(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "a", "name": "A", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })).json()["id"]
    sha = await _upload(client, headers, b"bytes-1", name="f1.parquet")
    f = (await client.post(f"{API}/data-sources/files/import", headers=headers, json={
        "dataSourceId": src, "sha": sha, "fileName": "f1.parquet", "fileSize": 7,
    })).json()

    listed = (await client.get(f"{API}/data-sources/{src}/files", headers=headers)).json()
    assert [x["id"] for x in listed] == [f["id"]]

    assert (await client.delete(f"{API}/data-sources/files/{f['id']}", headers=headers)).status_code == 204
    assert not blob_store.exists(sha)  # last reference gone


async def test_import_missing_blob_is_400(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "a", "name": "A", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/files/import", headers=headers, json={
        "dataSourceId": src, "sha": "0" * 64, "fileName": "x.parquet", "fileSize": 1,
    })
    assert r.status_code == 400


async def test_test_connection_unsupported_engine(client):
    headers = await _admin_headers(client)
    r = await client.post(f"{API}/data-sources/test-connection", headers=headers, json={
        "connectionConfig": {"engine": "duckdb"},
    })
    assert r.status_code == 200
    assert r.json()["ok"] is False and "unsupported" in r.json()["error"]


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    ds = (await client.post(f"{API}/data-sources", headers=admin, json={
        "workspaceId": ws, "alias": "a", "name": "A", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })).json()

    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/data-sources?workspaceId={ws}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/data-sources/{ds['id']}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/data-sources/{ds['id']}", headers=other)).status_code == 403
    # A workspace-filtered list they can't see returns 403; unfiltered omits it.
    assert (await client.get(f"{API}/data-sources", headers=other)).json() == []


# Opt-in live test: set LINKR_TEST_PG_DSN to a JSON connectionConfig, e.g.
#   LINKR_TEST_PG_DSN='{"engine":"postgresql","host":"127.0.0.1","port":5432,
#                       "database":"linkr","username":"me","password":"pw"}'
@pytest.mark.skipif(
    not os.environ.get("LINKR_TEST_PG_DSN"),
    reason="set LINKR_TEST_PG_DSN to run the live Postgres introspection test",
)
async def test_live_postgres_introspection():
    import json

    config = json.loads(os.environ["LINKR_TEST_PG_DSN"])
    ok, error, tables = await run_test_connection(config)
    assert ok, error
    assert isinstance(tables, list)
    for t in tables:
        assert "name" in t and isinstance(t["columns"], list)


@pytest.mark.skipif(
    not os.environ.get("LINKR_TEST_PG_DSN"),
    reason="set LINKR_TEST_PG_DSN to run the live Postgres query test",
)
async def test_live_postgres_query():
    import json

    from app.services.data import db_connect

    config = json.loads(os.environ["LINKR_TEST_PG_DSN"])
    rows = await asyncio.to_thread(
        db_connect.query_external, config, config.get("password"), "SELECT 1 AS one"
    )
    assert rows == [{"one": 1}]


async def test_create_from_ddl_materialises_the_database(client, tmp_path, monkeypatch):
    """Server mode must build the tables on disk: the browser path only creates
    them in its own WASM database, leaving the server with an empty catalog."""
    from app.config import settings
    from app.services.data import managed_db

    monkeypatch.setattr(type(settings), "data_path", property(lambda _: tmp_path))

    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    created = (
        await client.post(
            f"{API}/data-sources",
            headers=headers,
            json={
                "workspaceId": ws,
                "alias": "omop",
                "name": "OMOP",
                "sourceType": "database",
                "connectionConfig": {"engine": "duckdb"},
            },
        )
    ).json()

    ddl = (
        "CREATE TABLE person (person_id BIGINT);"
        "CREATE TABLE concept (concept_id BIGINT);"
        # DuckDB rejects ADD CONSTRAINT; the OMOP DDL is full of them.
        "ALTER TABLE person ADD CONSTRAINT fk FOREIGN KEY (person_id)"
        " REFERENCES concept (concept_id);"
    )
    r = await client.post(
        f"{API}/data-sources/{created['id']}/create-from-ddl",
        headers=headers,
        json={"ddl": ddl},
    )
    assert r.status_code == 200, r.text
    assert r.json()["connectionConfig"]["managed"] is True
    assert managed_db.exists(created["id"])

    rows = (
        await client.post(
            f"{API}/data-sources/{created['id']}/query",
            headers=headers,
            json={"sql": "SELECT count(*) AS n FROM person"},
        )
    ).json()["rows"]
    assert rows == [{"n": 0}]

    # The schema browser reads this endpoint: a managed database has no blob in
    # the file store, so introspection must look at the managed file instead of
    # reporting an empty schema.
    schema = (
        await client.get(
            f"{API}/data-sources/{created['id']}/schema", headers=headers
        )
    ).json()
    assert {t["name"] for t in schema} == {"person", "concept"}


async def test_managed_database_exposes_its_file_path(client, tmp_path, monkeypatch):
    """The user attaches the same .duckdb from an R/Python script outside Linkr,
    so the sidebar needs the real disk path."""
    from app.config import settings
    from app.services.data import managed_db

    monkeypatch.setattr(type(settings), "data_path", property(lambda _: tmp_path))

    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    created = (
        await client.post(
            f"{API}/data-sources",
            headers=headers,
            json={
                "workspaceId": ws,
                "alias": "omop",
                "name": "OMOP",
                "sourceType": "database",
                "connectionConfig": {"engine": "duckdb"},
            },
        )
    ).json()

    # Before materialisation: not managed yet, so there is no path to hand out.
    before = (
        await client.get(f"{API}/data-sources/{created['id']}/connection-info", headers=headers)
    ).json()
    assert before["path"] is None and before["exists"] is False

    await client.post(
        f"{API}/data-sources/{created['id']}/create-from-ddl",
        headers=headers,
        json={"ddl": "CREATE TABLE person (person_id BIGINT);"},
    )

    after = (
        await client.get(f"{API}/data-sources/{created['id']}/connection-info", headers=headers)
    ).json()
    assert after["exists"] is True
    assert after["kind"] == "file"
    assert after["path"] == str(managed_db.path_for(created["id"]))
    assert after["path"].endswith(".duckdb")
    # A managed file is named by the source id, not content-addressed.
    assert after["blob"] is False


async def test_connection_info_requires_read_access(client, db):
    """It discloses a server filesystem path, so it is permission-gated."""
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    created = (
        await client.post(
            f"{API}/data-sources",
            headers=headers,
            json={
                "workspaceId": ws,
                "alias": "omop",
                "name": "OMOP",
                "sourceType": "database",
                "connectionConfig": {"engine": "duckdb"},
            },
        )
    ).json()
    other = await _create_user(db, client, "mallory")
    r = await client.get(f"{API}/data-sources/{created['id']}/connection-info", headers=other)
    assert r.status_code in (403, 404)


async def test_connection_info_for_an_external_engine_omits_the_password(client):
    """Postgres/MySQL answer with host/port/database so the user can reconnect from
    another tool — but the password must never come back out."""
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    created = (
        await client.post(
            f"{API}/data-sources",
            headers=headers,
            json={
                "workspaceId": ws,
                "alias": "pg",
                "name": "PG",
                "sourceType": "database",
                "connectionConfig": {
                    "engine": "postgresql",
                    "host": "db.example.org",
                    "port": 5432,
                    "database": "omop",
                    "schema": "cdm",
                    "username": "reader",
                    "password": "s3cret",
                },
            },
        )
    ).json()

    info = (
        await client.get(f"{API}/data-sources/{created['id']}/connection-info", headers=headers)
    ).json()
    assert info["kind"] == "external"
    assert info["host"] == "db.example.org" and info["port"] == 5432
    assert info["database"] == "omop" and info["schemaName"] == "cdm"
    assert info["username"] == "reader"
    assert "password" not in info
    assert "s3cret" not in str(info)
    # No local file for a network database.
    assert info["path"] is None


async def test_connection_info_for_a_parquet_folder_points_at_the_directory(client, tmp_path, monkeypatch):
    """A script outside Linkr globs the FOLDER, not one of the tables."""
    from app.config import settings

    monkeypatch.setattr(type(settings), "data_path", property(lambda _: tmp_path))

    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    created = (
        await client.post(
            f"{API}/data-sources",
            headers=headers,
            json={
                "workspaceId": ws,
                "alias": "pq",
                "name": "PQ",
                "sourceType": "database",
                "connectionConfig": {"engine": "duckdb"},
            },
        )
    ).json()

    for name in ("person.parquet", "visit_occurrence.parquet"):
        data = f"{name} contents".encode()
        sha = await _upload(client, headers, data, name=name)
        await client.post(
            f"{API}/data-sources/files/import",
            headers=headers,
            json={
                "dataSourceId": created["id"],
                "sha": sha,
                "fileName": name,
                "fileSize": len(data),
            },
        )

    info = (
        await client.get(f"{API}/data-sources/{created['id']}/connection-info", headers=headers)
    ).json()
    assert info["kind"] == "parquet-folder"
    assert sorted(info["fileNames"]) == ["person.parquet", "visit_occurrence.parquet"]
    # The directory, and it must not be one of the table files.
    assert not info["path"].endswith(".parquet")
    assert info["blob"] is True
