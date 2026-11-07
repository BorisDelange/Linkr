"""An author snapshot re-links to a local account by email only when the writer may
already read that account's email."""

API = "/api/v1"


async def _login(client, username: str, password: str) -> dict:
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": password})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _setup(client):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    admin = await _login(client, "admin", "pw-for-tests-only")
    wsa = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "A"}})).json()["id"]
    wsb = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "B"}})).json()["id"]
    ids = {}
    for name, extra in (
        ("target", {"email": "target@example.test"}),
        ("colleague", {"email": "colleague@example.test"}),
        ("orcided", {"orcid": "0000-0000-0000-0001"}),
        ("ed", {"email": "ed@example.test"}),
    ):
        ids[name] = (await client.post(f"{API}/users", headers=admin, json={
            "username": name, "password": f"pw-for-tests-only-{name}", **extra,
        })).json()["id"]
    for ws, name, role in ((wsa, "target", "editor"), (wsb, "colleague", "viewer"), (wsb, "ed", "editor")):
        assert (await client.put(
            f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": ids[name], "role": role},
        )).status_code == 200
    editor = await _login(client, "ed", "pw-for-tests-only-ed")
    assert (await client.post(
        f"{API}/mapping-projects", headers=admin, json={"id": "mpb", "workspaceId": wsb, "name": {"en": "M"}},
    )).status_code == 201
    return admin, editor, wsb, ids


async def _relinked(client, headers, details: dict):
    r = await client.patch(f"{API}/mapping-projects/mpb", headers=headers, json={"createdByDetails": details})
    assert r.status_code == 200, r.text
    return r.json()["createdById"]


async def test_an_email_outside_the_writers_reach_is_not_linked(client, seed_roles):
    _, editor, wsb, ids = await _setup(client)
    assert await _relinked(client, editor, {"email": "target@example.test"}) is None
    created = await client.post(f"{API}/user-plugins", headers=editor, json={
        "id": "plug1", "workspaceId": wsb, "createdByDetails": {"email": "target@example.test"},
    })
    assert created.status_code == 201, created.text
    assert created.json()["createdById"] is None


async def test_an_email_the_writer_may_read_still_links(client, seed_roles):
    admin, editor, _, ids = await _setup(client)
    assert await _relinked(client, editor, {"email": "colleague@example.test"}) == ids["colleague"]
    assert await _relinked(client, editor, {"email": "ed@example.test"}) == ids["ed"]
    assert await _relinked(client, admin, {"email": "target@example.test"}) == ids["target"]


async def test_an_orcid_links_whoever_writes(client, seed_roles):
    _, editor, _, ids = await _setup(client)
    assert await _relinked(client, editor, {"orcid": "0000-0000-0000-0001"}) == ids["orcided"]
