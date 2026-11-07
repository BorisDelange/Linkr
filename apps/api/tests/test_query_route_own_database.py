"""Through the query route, a workspace viewer reads the SQLite database it was
given and nothing else, whatever characters the statement holds and whatever
views the file stores."""

import sqlite3

from app.config import settings
from tests.test_ide_files import _admin_headers
from tests.test_server_folder_boundary import (
    _source_body,
    _sqlite_with_users,
    _workspace,
)

API = "/api/v1"


async def _viewer(client, admin, ws: str) -> dict:
    user = (await client.post(
        f"{API}/users", headers=admin, json={"username": "reader", "password": "pw-for-tests-only-b"}
    )).json()["id"]
    assert (await client.put(
        f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": user, "role": "viewer"}
    )).status_code == 200
    token = (await client.post(
        f"{API}/auth/login", json={"username": "reader", "password": "pw-for-tests-only-b"}
    )).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def test_a_viewer_reads_only_its_sqlite_database_whatever_the_characters(client, seed_roles, tmp_path_factory):
    folder = tmp_path_factory.mktemp("server")
    own = folder / "own.db"
    _sqlite_with_users(own)
    other = folder / "other.db"
    _sqlite_with_users(other)
    settings.data_path.mkdir(parents=True, exist_ok=True)
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    source = (await client.post(f"{API}/data-sources", headers=admin, json=_source_body(ws, own))).json()["id"]
    reader = await _viewer(client, admin, ws)

    query = f"{API}/data-sources/{source}/query"
    ok = await client.post(query, headers=reader, json={"sql": "SELECT 'é' AS m, username FROM users"})
    assert ok.status_code == 200
    for path in (other, settings.data_path / "linkr.db"):
        for sql in (
            f"SELECT 'é' AS m, username FROM sqlite_scan('{path}', 'users')",
            f"/* é */ SELECT username FROM sqlite_scan('{path}', 'users')",
            f"SELECT username FROM sqlite_scan\u200b('{path}', 'users')",
            f"/* é */ CALL sqlite_attach('{path}')",
        ):
            refused = await client.post(query, headers=reader, json={"sql": sql})
            assert refused.status_code == 400, sql
            assert "secret" not in refused.text


async def test_a_view_stored_in_the_database_reads_only_that_database(client, seed_roles, tmp_path_factory):
    folder = tmp_path_factory.mktemp("server")
    other = folder / "other.db"
    _sqlite_with_users(other)
    own = folder / "own.db"
    _sqlite_with_users(own)
    con = sqlite3.connect(own)
    con.execute(f"CREATE VIEW v_users AS SELECT username, password_hash FROM sqlite_scan('{other}', 'users')")
    con.commit()
    con.close()
    settings.data_path.mkdir(parents=True, exist_ok=True)
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    source = (await client.post(f"{API}/data-sources", headers=admin, json=_source_body(ws, own))).json()["id"]
    reader = await _viewer(client, admin, ws)

    refused = await client.post(f"{API}/data-sources/{source}/query", headers=reader, json={"sql": "SELECT * FROM v_users"})
    assert refused.status_code == 400
    assert "secret" not in refused.text
