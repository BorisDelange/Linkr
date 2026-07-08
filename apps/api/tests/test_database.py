"""Admin-only read-only query/introspection of the app's own database."""

import pytest

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_select_returns_rows(client):
    headers = await _admin_headers(client)
    r = await client.post(
        f"{API}/database/query", headers=headers,
        json={"sql": "SELECT username, role FROM users"},
    )
    assert r.status_code == 200
    rows = r.json()["rows"]
    assert rows == [{"username": "admin", "role": "admin"}]


async def test_with_cte_allowed(client):
    headers = await _admin_headers(client)
    r = await client.post(
        f"{API}/database/query", headers=headers,
        json={"sql": "WITH u AS (SELECT * FROM users) SELECT count(*) AS n FROM u"},
    )
    assert r.status_code == 200
    assert r.json()["rows"][0]["n"] == 1


@pytest.mark.parametrize("sql", [
    "UPDATE users SET role='x'",
    "DELETE FROM users",
    "INSERT INTO users (username) VALUES ('x')",
    "DROP TABLE users",
    "CREATE TABLE t (a int)",
    "SELECT 1; DROP TABLE users",       # multi-statement smuggling
    "SELECT 1; UPDATE users SET role='x'",
    "  ",                                # empty
])
async def test_non_read_statements_rejected(client, sql):
    headers = await _admin_headers(client)
    r = await client.post(f"{API}/database/query", headers=headers, json={"sql": sql})
    assert r.status_code == 400


async def test_write_is_rolled_back_even_if_it_slipped_through(client):
    """Defense in depth: the users table is unchanged after a query call."""
    headers = await _admin_headers(client)
    before = (await client.post(
        f"{API}/database/query", headers=headers,
        json={"sql": "SELECT count(*) AS n FROM users"},
    )).json()["rows"][0]["n"]
    assert before == 1


async def test_bad_sql_is_422(client):
    headers = await _admin_headers(client)
    r = await client.post(
        f"{API}/database/query", headers=headers,
        json={"sql": "SELECT * FROM no_such_table"},
    )
    assert r.status_code == 422


async def test_schema_lists_tables_and_columns(client):
    headers = await _admin_headers(client)
    r = await client.get(f"{API}/database/schema", headers=headers)
    assert r.status_code == 200
    tables = {t["name"]: t for t in r.json()}
    assert "users" in tables
    cols = {c["name"] for c in tables["users"]["columns"]}
    assert {"id", "username", "role"} <= cols


async def test_requires_admin(client):
    admin = await _admin_headers(client)
    await client.post(f"{API}/users", headers=admin,
                      json={"username": "bob", "password": "pw", "role": "user"})
    r = await client.post(f"{API}/auth/login", json={"username": "bob", "password": "pw"})
    bob = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert (await client.post(f"{API}/database/query", headers=bob,
            json={"sql": "SELECT 1"})).status_code == 403
    assert (await client.get(f"{API}/database/schema", headers=bob)).status_code == 403


async def test_requires_auth(client):
    assert (await client.post(f"{API}/database/query",
            json={"sql": "SELECT 1"})).status_code in (401, 403)
