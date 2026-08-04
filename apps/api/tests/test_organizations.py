API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_organization_crud(client):
    headers = await _admin_headers(client)

    r = await client.post(
        f"{API}/organizations",
        headers=headers,
        json={"name": "CHU Rennes", "type": "hospital", "referenceId": "ror:123"},
    )
    assert r.status_code == 201
    org = r.json()
    assert org["name"] == "CHU Rennes"
    assert org["referenceId"] == "ror:123"  # camelCase boundary
    assert "createdAt" in org
    org_id = org["id"]

    r = await client.get(f"{API}/organizations", headers=headers)
    assert any(o["id"] == org_id for o in r.json())

    r = await client.get(f"{API}/organizations/{org_id}", headers=headers)
    assert r.status_code == 200

    r = await client.patch(
        f"{API}/organizations/{org_id}",
        headers=headers,
        json={"location": "Rennes, France"},
    )
    assert r.status_code == 200 and r.json()["location"] == "Rennes, France"

    r = await client.delete(f"{API}/organizations/{org_id}", headers=headers)
    assert r.status_code == 204
    assert (
        await client.get(f"{API}/organizations/{org_id}", headers=headers)
    ).status_code == 404


async def test_multilingual_fields_round_trip(client):
    headers = await _admin_headers(client)
    r = await client.post(
        f"{API}/organizations",
        headers=headers,
        json={
            "name": {"en": "Rennes Hospital", "fr": "CHU de Rennes"},
            "location": {"en": "Rennes", "fr": "Rennes"},
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == {"en": "Rennes Hospital", "fr": "CHU de Rennes"}
    assert body["location"] == {"en": "Rennes", "fr": "Rennes"}


async def test_client_supplied_id_kept(client):
    headers = await _admin_headers(client)
    r = await client.post(
        f"{API}/organizations",
        headers=headers,
        json={"id": "org-fixed", "name": "X"},
    )
    assert r.status_code == 201 and r.json()["id"] == "org-fixed"


async def test_import_preserves_created_at(client):
    """A workspace import reconstitutes the org with its snapshot createdAt;
    the server must keep it (not stamp now) or organization.json churns on
    every import→export git round-trip."""
    headers = await _admin_headers(client)
    r = await client.post(
        f"{API}/organizations",
        headers=headers,
        json={
            "id": "org-imported",
            "name": {"en": "RiCDC"},
            "createdAt": "2026-07-24T09:56:57.000Z",
        },
    )
    assert r.status_code == 201
    assert r.json()["createdAt"] == "2026-07-24T09:56:57.000Z"


async def test_requires_auth(client):
    r = await client.get(f"{API}/organizations")
    assert r.status_code in (401, 403)


async def test_read_open_write_requires_permission(client):
    """Organizations are a shared reference directory: any authenticated user may
    LIST/READ them, but creating/editing/deleting requires organizations:write /
    organizations:delete (admin-only by default)."""
    admin = await _admin_headers(client)
    await client.post(
        f"{API}/users",
        headers=admin,
        json={"username": "bob", "password": "pw", "role": "user"},
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "bob", "password": "pw"}
    )
    bob = {"Authorization": f"Bearer {r.json()['access_token']}"}

    org_id = (
        await client.post(f"{API}/organizations", headers=admin, json={"name": "X"})
    ).json()["id"]

    # Read is open to any authenticated user (directory).
    assert (await client.get(f"{API}/organizations", headers=bob)).status_code == 200
    assert (await client.get(f"{API}/organizations/{org_id}", headers=bob)).status_code == 200
    # Mutations are gated.
    assert (
        await client.post(f"{API}/organizations", headers=bob, json={"name": "Y"})
    ).status_code == 403
    assert (
        await client.patch(
            f"{API}/organizations/{org_id}", headers=bob, json={"name": "Z"}
        )
    ).status_code == 403
    assert (
        await client.delete(f"{API}/organizations/{org_id}", headers=bob)
    ).status_code == 403
