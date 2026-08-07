"""Assistant chat threads.

The property that matters is isolation: a conversation may quote clinical
context from the page it was opened on, so no user — whatever their role — may
read, edit or delete another's.
"""

from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _make_user(db, client, username: str) -> tuple[int, dict]:
    user = User(username=username, password_hash=hash_password("pw"), role="user")
    db.add(user)
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw"})
    return user.id, {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _workspace(client, headers) -> str:
    return (
        await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})
    ).json()["id"]


async def _member(client, admin, ws: str, user_id: int, role: str = "editor") -> None:
    await client.put(
        f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": user_id, "role": role}
    )


async def _create(client, headers, ws: str, **overrides):
    payload = {
        "workspaceId": ws,
        "surface": "dashboard",
        "title": "Add a tab",
        "messages": [{"role": "user", "content": "Ajoute un onglet Test"}],
    }
    payload.update(overrides)
    return await client.post(f"{API}/agent-conversations", headers=headers, json=payload)


async def test_conversation_crud(client):
    headers = await _admin(client)
    ws = await _workspace(client, headers)

    created = await _create(client, headers, ws)
    assert created.status_code == 201
    body = created.json()
    assert body["title"] == "Add a tab" and body["messageCount"] == 1

    listed = (await client.get(f"{API}/agent-conversations?workspaceId={ws}", headers=headers)).json()
    assert [c["id"] for c in listed] == [body["id"]]

    fetched = (
        await client.get(f"{API}/agent-conversations/{body['id']}", headers=headers)
    ).json()
    assert fetched["messages"][0]["content"] == "Ajoute un onglet Test"

    patched = await client.patch(
        f"{API}/agent-conversations/{body['id']}",
        headers=headers,
        json={"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]},
    )
    assert patched.json()["messageCount"] == 2

    assert (
        await client.delete(f"{API}/agent-conversations/{body['id']}", headers=headers)
    ).status_code == 204
    assert (
        await client.get(f"{API}/agent-conversations?workspaceId={ws}", headers=headers)
    ).json() == []


async def test_listing_never_returns_messages(client):
    """The history list is browsed casually; shipping every past prompt with it
    would spread clinical context further than opening one thread does."""
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    await _create(client, headers, ws)

    listing = await client.get(f"{API}/agent-conversations?workspaceId={ws}", headers=headers)
    assert "Ajoute un onglet Test" not in listing.text
    assert "messages" not in listing.json()[0]
    assert listing.json()[0]["messageCount"] == 1


async def test_a_user_cannot_read_another_users_conversation(client, db):
    admin = await _admin(client)
    ws = await _workspace(client, admin)
    alice_id, alice = await _make_user(db, client, "alice")
    bob_id, bob = await _make_user(db, client, "bob")
    await _member(client, admin, ws, alice_id)
    await _member(client, admin, ws, bob_id)

    cid = (await _create(client, alice, ws, title="Alice private")).json()["id"]

    # Bob is a legitimate member of the same workspace — and still sees nothing.
    assert (await client.get(f"{API}/agent-conversations?workspaceId={ws}", headers=bob)).json() == []
    got = await client.get(f"{API}/agent-conversations/{cid}", headers=bob)
    assert got.status_code == 404
    assert "Alice private" not in got.text

    # Alice still has it.
    assert (await client.get(f"{API}/agent-conversations/{cid}", headers=alice)).status_code == 200


async def test_even_an_owner_cannot_read_another_users_conversation(client, db):
    """Ownership of the workspace is not a key to other people's prompts."""
    admin = await _admin(client)
    ws = await _workspace(client, admin)
    alice_id, alice = await _make_user(db, client, "alice")
    await _member(client, admin, ws, alice_id)

    cid = (await _create(client, alice, ws)).json()["id"]

    assert (await client.get(f"{API}/agent-conversations?workspaceId={ws}", headers=admin)).json() == []
    assert (await client.get(f"{API}/agent-conversations/{cid}", headers=admin)).status_code == 404


async def test_a_user_cannot_modify_or_delete_another_users_conversation(client, db):
    admin = await _admin(client)
    ws = await _workspace(client, admin)
    alice_id, alice = await _make_user(db, client, "alice")
    bob_id, bob = await _make_user(db, client, "bob")
    await _member(client, admin, ws, alice_id)
    await _member(client, admin, ws, bob_id)

    cid = (await _create(client, alice, ws)).json()["id"]

    assert (
        await client.patch(
            f"{API}/agent-conversations/{cid}", headers=bob, json={"title": "hijacked"}
        )
    ).status_code == 404
    assert (await client.delete(f"{API}/agent-conversations/{cid}", headers=bob)).status_code == 404

    # Untouched.
    assert (await client.get(f"{API}/agent-conversations/{cid}", headers=alice)).json()[
        "title"
    ] == "Add a tab"


async def test_user_id_comes_from_the_token_not_the_payload(client, db):
    """Filing a thread under someone else's name would let a user plant content
    in another's history."""
    admin = await _admin(client)
    ws = await _workspace(client, admin)
    alice_id, alice = await _make_user(db, client, "alice")
    bob_id, bob = await _make_user(db, client, "bob")
    await _member(client, admin, ws, alice_id)
    await _member(client, admin, ws, bob_id)

    created = await _create(client, bob, ws, userId=alice_id, title="planted")
    assert created.status_code == 201

    # It landed in bob's history, not alice's.
    assert [c["title"] for c in (
        await client.get(f"{API}/agent-conversations?workspaceId={ws}", headers=bob)
    ).json()] == ["planted"]
    assert (await client.get(f"{API}/agent-conversations?workspaceId={ws}", headers=alice)).json() == []


async def test_clear_all_only_clears_the_callers_own(client, db):
    admin = await _admin(client)
    ws = await _workspace(client, admin)
    alice_id, alice = await _make_user(db, client, "alice")
    bob_id, bob = await _make_user(db, client, "bob")
    await _member(client, admin, ws, alice_id)
    await _member(client, admin, ws, bob_id)

    await _create(client, alice, ws, title="alice 1")
    await _create(client, alice, ws, title="alice 2")
    await _create(client, bob, ws, title="bob 1")

    assert (
        await client.delete(f"{API}/agent-conversations?workspaceId={ws}", headers=alice)
    ).status_code == 204

    assert (await client.get(f"{API}/agent-conversations?workspaceId={ws}", headers=alice)).json() == []
    # Bob's survived.
    assert [c["title"] for c in (
        await client.get(f"{API}/agent-conversations?workspaceId={ws}", headers=bob)
    ).json()] == ["bob 1"]


async def test_clear_all_can_be_scoped_to_one_surface(client):
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    await _create(client, headers, ws, surface="dashboard", title="d")
    await _create(client, headers, ws, surface="ide", title="i")

    await client.delete(f"{API}/agent-conversations?workspaceId={ws}&surface=dashboard", headers=headers)

    remaining = (
        await client.get(f"{API}/agent-conversations?workspaceId={ws}", headers=headers)
    ).json()
    assert [c["title"] for c in remaining] == ["i"]


async def test_list_filters_by_project_surface_and_entity(client):
    """The sidebar shows the history of the page you are on, not everything."""
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    await _create(client, headers, ws, projectUid="p1", entityId="dash-1", title="a")
    await _create(client, headers, ws, projectUid="p1", entityId="dash-2", title="b")
    await _create(client, headers, ws, projectUid="p2", entityId="dash-1", title="c")
    await _create(client, headers, ws, projectUid="p1", entityId="dash-1", surface="ide", title="d")

    titles = lambda q: sorted(  # noqa: E731
        c["title"] for c in q
    )

    r = await client.get(
        f"{API}/agent-conversations?workspaceId={ws}&projectUid=p1&entityId=dash-1", headers=headers
    )
    assert titles(r.json()) == ["a", "d"]

    r = await client.get(
        f"{API}/agent-conversations?workspaceId={ws}&projectUid=p1&entityId=dash-1&surface=dashboard",
        headers=headers,
    )
    assert titles(r.json()) == ["a"]


async def test_non_member_cannot_create_or_list(client, db):
    admin = await _admin(client)
    ws = await _workspace(client, admin)
    _, mallory = await _make_user(db, client, "mallory")

    assert (await _create(client, mallory, ws)).status_code == 403
    assert (
        await client.get(f"{API}/agent-conversations?workspaceId={ws}", headers=mallory)
    ).status_code == 403


async def test_conversations_are_scoped_to_their_workspace(client):
    headers = await _admin(client)
    ws_a = await _workspace(client, headers)
    ws_b = await _workspace(client, headers)
    await _create(client, headers, ws_a)

    assert (
        await client.get(f"{API}/agent-conversations?workspaceId={ws_b}", headers=headers)
    ).json() == []
