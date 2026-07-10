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


async def test_requires_auth(client):
    r = await client.get(f"{API}/organizations")
    assert r.status_code in (401, 403)


async def test_requires_organizations_permission(client):
    """Organizations are a global-tier resource (organizations:read/write/delete),
    admin-only by default. A base (non-admin) user can neither read nor mutate them."""
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

    assert (await client.get(f"{API}/organizations", headers=bob)).status_code == 403
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
