"""A database alias is unique within its workspace, not across the instance."""

API = "/api/v1"


async def _setup(client) -> tuple[dict, str, str]:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    ws_a = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "A"}})).json()["id"]
    ws_b = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "B"}})).json()["id"]
    return headers, ws_a, ws_b


async def _create(client, headers, ws, alias, name="DB"):
    return await client.post(f"{API}/data-sources", headers=headers,
                             json={"workspaceId": ws, "alias": alias, "name": {"en": name}})


async def test_same_alias_in_two_workspaces_is_allowed(client):
    headers, ws_a, ws_b = await _setup(client)
    assert (await _create(client, headers, ws_a, "mimic")).status_code == 201
    # The same database installed in another workspace keeps its alias.
    assert (await _create(client, headers, ws_b, "mimic")).status_code == 201


async def test_same_alias_in_one_workspace_is_refused(client):
    headers, ws_a, _ = await _setup(client)
    assert (await _create(client, headers, ws_a, "mimic")).status_code == 201
    r = await _create(client, headers, ws_a, "mimic", name="Other")
    assert r.status_code == 409
    assert "mimic" in r.json()["detail"]


async def test_changing_the_alias_to_a_taken_one_is_refused(client):
    headers, ws_a, ws_b = await _setup(client)
    await _create(client, headers, ws_a, "mimic")
    other = (await _create(client, headers, ws_a, "omop")).json()
    r = await client.patch(f"{API}/data-sources/{other['id']}", headers=headers, json={"alias": "mimic"})
    assert r.status_code == 409
    # Keeping its own alias, or taking one only another workspace uses, is fine.
    await _create(client, headers, ws_b, "eicu")
    assert (await client.patch(f"{API}/data-sources/{other['id']}", headers=headers, json={"alias": "omop"})).status_code == 200
    assert (await client.patch(f"{API}/data-sources/{other['id']}", headers=headers, json={"alias": "eicu"})).status_code == 200


async def test_aliases_are_compared_as_duckdb_mounts_them(client):
    # `ds_My-DB` and `ds_my_db` are one catalog to DuckDB, which ignores case.
    headers, ws_a, _ = await _setup(client)
    assert (await _create(client, headers, ws_a, "my_db")).status_code == 201
    assert (await _create(client, headers, ws_a, "My-DB", name="Other")).status_code == 409
    assert (await _create(client, headers, ws_a, "MIMIC")).status_code == 201
    r = await _create(client, headers, ws_a, "mimic", name="Other")
    assert r.status_code == 409
    assert "MIMIC" in r.json()["detail"]


def test_alias_key_matches_the_frontend():
    # Same cases as `aliasKey` in apps/web/src/lib/alias.test.ts.
    from app.services.data_source_service import alias_key

    assert alias_key("My-DB") == alias_key("my_db") == "my_db"
    assert alias_key("MIMIC") == "mimic"
    assert alias_key("a.b c") == "a_b_c"


async def test_the_database_refuses_a_duplicate_the_check_missed(client, monkeypatch):
    # Two concurrent creates both pass the check; the constraint stops the second.
    from app.services import data_source_service

    headers, ws_a, _ = await _setup(client)
    assert (await _create(client, headers, ws_a, "mimic")).status_code == 201

    async def no_check(*_args, **_kwargs):
        return None

    monkeypatch.setattr(data_source_service, "ensure_alias_free", no_check)
    r = await _create(client, headers, ws_a, "mimic", name="Other")
    assert r.status_code == 409
    assert "mimic" in r.json()["detail"]


async def test_the_database_refuses_a_normalised_duplicate_the_check_missed(client, monkeypatch):
    # `My-DB` vs `my_db`: distinct raw aliases, one DuckDB catalog.
    from app.services import data_source_service

    headers, ws_a, _ = await _setup(client)
    assert (await _create(client, headers, ws_a, "my_db")).status_code == 201

    async def no_check(*_args, **_kwargs):
        return None

    monkeypatch.setattr(data_source_service, "ensure_alias_free", no_check)
    assert (await _create(client, headers, ws_a, "My-DB", name="Other")).status_code == 409
    other = (await _create(client, headers, ws_a, "omop")).json()
    r = await client.patch(f"{API}/data-sources/{other['id']}", headers=headers, json={"alias": "MY.DB"})
    assert r.status_code == 409
