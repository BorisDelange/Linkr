"""Every route that clears a mapping project's suggestions answers to one permission."""

API = "/api/v1"
_ROW = {"sourceVocabularyId": "V", "sourceConceptCode": "c1", "conceptId": 1, "method": "ai/dummy", "score": 0.9}


async def _login(client, username: str, password: str) -> dict:
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": password})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _setup(client) -> tuple[dict, dict, dict, str]:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    owner = await _login(client, "admin", "pw-for-tests-only")
    ws = (await client.post(f"{API}/workspaces", headers=owner, json={"name": {"en": "W"}})).json()["id"]
    assert (await client.post(
        f"{API}/mapping-projects", headers=owner, json={"id": "mpv", "workspaceId": ws, "name": {"en": "M"}},
    )).status_code == 201
    members = {}
    for name, role in (("ed", "editor"), ("view", "viewer")):
        uid = (await client.post(
            f"{API}/users", headers=owner, json={"username": name, "password": f"pw-for-tests-only-{name}"},
        )).json()["id"]
        assert (await client.put(
            f"{API}/workspaces/{ws}/members", headers=owner, json={"userId": uid, "role": role},
        )).status_code == 200
        members[name] = await _login(client, name, f"pw-for-tests-only-{name}")
    return owner, members["ed"], members["view"], f"{API}/mapping-projects/mpv"


async def _seed(client, owner: dict, base: str) -> None:
    assert (await client.post(f"{base}/scores/append", headers=owner, json={"rows": [_ROW]})).status_code == 200
    assert (await client.get(base, headers=owner)).json()["scoresFileSha"]


def _clearers(client, base: str):
    return {
        "delete": lambda h: client.delete(f"{base}/scores-file", headers=h),
        "remove": lambda h: client.post(f"{base}/scores/remove", headers=h, json={"methods": ["ai/dummy"]}),
        "patch": lambda h: client.patch(base, headers=h, json={"scoresFileSha": None}),
    }


async def test_an_editor_gets_the_same_answer_from_every_route_that_clears_suggestions(client, seed_roles):
    owner, editor, _, base = await _setup(client)
    for name, clear in _clearers(client, base).items():
        await _seed(client, owner, base)
        r = await clear(editor)
        assert r.status_code < 300, (name, r.status_code, r.text)
        assert (await client.get(base, headers=owner)).json()["scoresFileSha"] is None, name


async def test_a_viewer_clears_suggestions_through_no_route(client, seed_roles):
    owner, _, viewer, base = await _setup(client)
    await _seed(client, owner, base)
    for name, clear in _clearers(client, base).items():
        assert (await clear(viewer)).status_code == 403, name
    assert (await client.get(base, headers=owner)).json()["scoresFileSha"]
