"""LLM provider configuration.

The two things worth guarding here are the API key never reaching a browser,
and the pair of independent gates on a remote endpoint. A remote model means
clinical context leaving the institution, so both gates must fail closed.
"""

import pytest
from sqlalchemy import select

from app.config import settings
from app.core.crypto import decrypt
from app.core.security import hash_password
from app.models.llm_provider import LlmProvider
from app.models.user import User

API = "/api/v1"

LOCAL = "http://localhost:11434/v1"
REMOTE = "https://api.openai.com/v1"


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


async def _create(client, headers, ws: str, **overrides):
    payload = {
        "workspaceId": ws,
        "name": {"en": "Ollama"},
        "baseUrl": LOCAL,
        "model": "qwen3.5:4b",
        "surfaces": ["dashboard"],
    }
    payload.update(overrides)
    return await client.post(f"{API}/llm-providers", headers=headers, json=payload)


@pytest.fixture(autouse=True)
def _remote_disabled(monkeypatch):
    """Match production: remote endpoints are off unless a test opts in."""
    monkeypatch.setattr(settings, "allow_remote_llm", False)


async def test_local_provider_crud(client):
    headers = await _admin(client)
    ws = await _workspace(client, headers)

    created = await _create(client, headers, ws)
    assert created.status_code == 201
    body = created.json()
    assert body["isLocal"] is True
    assert body["surfaces"] == ["dashboard"]
    # No acknowledgement is demanded for a local endpoint.
    assert body["acknowledgedById"] is None

    listed = (await client.get(f"{API}/llm-providers?workspaceId={ws}", headers=headers)).json()
    assert [p["id"] for p in listed] == [body["id"]]

    patched = await client.patch(
        f"{API}/llm-providers/{body['id']}", headers=headers, json={"model": "qwen3.5:7b"}
    )
    assert patched.json()["model"] == "qwen3.5:7b"

    assert (
        await client.delete(f"{API}/llm-providers/{body['id']}", headers=headers)
    ).status_code == 204
    assert (await client.get(f"{API}/llm-providers?workspaceId={ws}", headers=headers)).json() == []


async def test_api_key_is_never_returned_but_is_stored_encrypted(client, db):
    """The key must be usable server-side yet absent from every response."""
    headers = await _admin(client)
    ws = await _workspace(client, headers)

    created = await _create(client, headers, ws, apiKey="sk-secret-value")
    body = created.json()
    assert body["hasApiKey"] is True
    assert "apiKey" not in body and "api_key" not in body
    assert "sk-secret-value" not in created.text

    listed = await client.get(f"{API}/llm-providers?workspaceId={ws}", headers=headers)
    assert "sk-secret-value" not in listed.text

    # ...but the server can still recover it, and it is not stored in the clear.
    row = (await db.scalars(select(LlmProvider).where(LlmProvider.id == body["id"]))).one()
    assert row.api_key_encrypted != "sk-secret-value"
    assert decrypt(row.api_key_encrypted) == "sk-secret-value"


async def test_api_key_absent_leaves_it_untouched_and_empty_clears_it(client, db):
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    pid = (await _create(client, headers, ws, apiKey="sk-keep")).json()["id"]

    # A patch that doesn't mention the key must not wipe it.
    r = await client.patch(f"{API}/llm-providers/{pid}", headers=headers, json={"model": "m2"})
    assert r.json()["hasApiKey"] is True

    r = await client.patch(f"{API}/llm-providers/{pid}", headers=headers, json={"apiKey": ""})
    assert r.json()["hasApiKey"] is False
    row = (await db.scalars(select(LlmProvider).where(LlmProvider.id == pid))).one()
    assert row.api_key_encrypted is None


async def test_remote_refused_when_instance_forbids_it(client):
    """First gate: the institution forbids egress outright."""
    headers = await _admin(client)
    ws = await _workspace(client, headers)

    r = await _create(client, headers, ws, baseUrl=REMOTE, acknowledgementText="I accept")
    assert r.status_code == 403
    assert "LINKR_ALLOW_REMOTE_LLM" in r.json()["detail"]


async def test_remote_refused_without_acknowledgement(client, monkeypatch):
    """Second gate: even where egress is allowed, someone must take
    responsibility. Failing closed matters — accepting silently would send
    clinical context to a third party by omission."""
    monkeypatch.setattr(settings, "allow_remote_llm", True)
    headers = await _admin(client)
    ws = await _workspace(client, headers)

    assert (await _create(client, headers, ws, baseUrl=REMOTE)).status_code == 400
    # Whitespace is not an acknowledgement.
    r = await _create(client, headers, ws, baseUrl=REMOTE, acknowledgementText="   ")
    assert r.status_code == 400

    ok = await _create(client, headers, ws, baseUrl=REMOTE, acknowledgementText="I accept")
    assert ok.status_code == 201
    body = ok.json()
    assert body["isLocal"] is False
    assert body["acknowledgedById"] is not None and body["acknowledgedAt"] is not None


async def test_locality_is_derived_server_side_not_client_declared(client):
    """A client claiming `isLocal` for a remote URL must not be believed."""
    headers = await _admin(client)
    ws = await _workspace(client, headers)

    r = await _create(client, headers, ws, baseUrl=REMOTE, isLocal=True)
    assert r.status_code == 403

    local = await _create(client, headers, ws, baseUrl=LOCAL, isLocal=False)
    assert local.json()["isLocal"] is True


async def test_switching_a_local_provider_to_remote_is_gated_too(client):
    """The guard belongs on update as well, or the gate is trivially bypassed
    by creating locally and then editing the URL."""
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    pid = (await _create(client, headers, ws)).json()["id"]

    r = await client.patch(
        f"{API}/llm-providers/{pid}", headers=headers, json={"baseUrl": REMOTE}
    )
    assert r.status_code == 403


async def test_repointing_a_remote_to_a_different_url_needs_a_fresh_acknowledgement(
    client, monkeypatch
):
    """The stored acknowledgement was given for one endpoint. Carrying it over to
    a different remote URL would let an admin silently re-point an approved
    provider at a third party."""
    monkeypatch.setattr(settings, "allow_remote_llm", True)
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    pid = (
        await _create(client, headers, ws, baseUrl=REMOTE, acknowledgementText="I accept")
    ).json()["id"]

    other = "https://api.mistral.ai/v1"
    # A different remote URL with no fresh acknowledgement is refused.
    r = await client.patch(
        f"{API}/llm-providers/{pid}", headers=headers, json={"baseUrl": other}
    )
    assert r.status_code == 400

    # The same URL keeps its acknowledgement (a model rename must not re-prompt).
    r = await client.patch(
        f"{API}/llm-providers/{pid}", headers=headers, json={"model": "renamed"}
    )
    assert r.status_code == 200

    # A different remote URL WITH a fresh acknowledgement is accepted and re-stamps.
    r = await client.patch(
        f"{API}/llm-providers/{pid}",
        headers=headers,
        json={"baseUrl": other, "acknowledgementText": "I accept again"},
    )
    assert r.status_code == 200


async def test_editor_cannot_write_but_owner_can(client, db):
    """llm-config:write is owner-only — an editor may see which models exist
    without being able to point the assistant at an endpoint of their choosing."""
    admin = await _admin(client)
    ws = await _workspace(client, admin)
    pid = (await _create(client, admin, ws)).json()["id"]

    bob_id, bob = await _make_user(db, client, "bob")
    await client.put(
        f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": bob_id, "role": "editor"}
    )

    # Reading is allowed...
    assert (await client.get(f"{API}/llm-providers?workspaceId={ws}", headers=bob)).status_code == 200
    # ...writing is not.
    assert (await _create(client, bob, ws, name={"en": "Rogue"})).status_code == 403
    assert (
        await client.patch(f"{API}/llm-providers/{pid}", headers=bob, json={"model": "x"})
    ).status_code == 403
    assert (await client.delete(f"{API}/llm-providers/{pid}", headers=bob)).status_code == 403

    # Promoting bob to owner unlocks exactly those calls.
    await client.put(
        f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": bob_id, "role": "owner"}
    )
    assert (
        await client.patch(f"{API}/llm-providers/{pid}", headers=bob, json={"model": "x"})
    ).status_code == 200


async def test_non_member_sees_nothing(client, db):
    admin = await _admin(client)
    ws = await _workspace(client, admin)
    await _create(client, admin, ws)
    _, mallory = await _make_user(db, client, "mallory")

    assert (
        await client.get(f"{API}/llm-providers?workspaceId={ws}", headers=mallory)
    ).status_code == 403


async def test_surface_filter_returns_only_approved_and_enabled(client):
    """This is the list a project page offers its users, so a model approved for
    the IDE must not silently become available in dashboards."""
    headers = await _admin(client)
    ws = await _workspace(client, headers)

    dash = (await _create(client, headers, ws, name={"en": "Dash"}, surfaces=["dashboard"])).json()
    await _create(client, headers, ws, name={"en": "Ide"}, surfaces=["ide"])
    both = (
        await _create(client, headers, ws, name={"en": "Both"}, surfaces=["dashboard", "ide"])
    ).json()
    off = (
        await _create(
            client, headers, ws, name={"en": "Off"}, surfaces=["dashboard"], enabled=False
        )
    ).json()

    ids = {
        p["id"]
        for p in (
            await client.get(
                f"{API}/llm-providers?workspaceId={ws}&surface=dashboard", headers=headers
            )
        ).json()
    }
    assert ids == {dash["id"], both["id"]}
    assert off["id"] not in ids

    # Unfiltered, everything in the workspace comes back.
    everything = (
        await client.get(f"{API}/llm-providers?workspaceId={ws}", headers=headers)
    ).json()
    assert len(everything) == 4


async def test_providers_are_scoped_to_their_workspace(client):
    headers = await _admin(client)
    ws_a = await _workspace(client, headers)
    ws_b = await _workspace(client, headers)
    await _create(client, headers, ws_a)

    assert (await client.get(f"{API}/llm-providers?workspaceId={ws_b}", headers=headers)).json() == []


# --- Bench reports ---------------------------------------------------------


def _report(ws: str, model: str = "qwen3.5:4b", **overrides) -> dict:
    payload = {
        "workspaceId": ws,
        "model": model,
        "mode": "quick",
        "lang": "en",
        "surfaces": ["dashboard"],
        "passed": 12,
        "total": 13,
        "totalMs": 45000,
        "promptTokens": 740,
        "completionTokens": 210,
        "tokensPerSecond": 21.5,
        "cases": [
            {
                "id": "add-tab",
                "label": "Add a tab",
                "lang": "en",
                "ok": True,
                "ms": 1200,
                "calls": ["add_tab"],
            }
        ],
    }
    payload.update(overrides)
    return payload


async def test_bench_report_rerun_replaces_previous_for_same_model(client):
    """Speed is machine-specific, so a stale run on the same deployment is
    noise once a newer one exists."""
    headers = await _admin(client)
    ws = await _workspace(client, headers)

    first = await client.post(f"{API}/llm-bench-reports", headers=headers, json=_report(ws))
    assert first.status_code == 201 and first.json()["passed"] == 12

    second = await client.post(
        f"{API}/llm-bench-reports", headers=headers, json=_report(ws, passed=13)
    )
    assert second.status_code == 201

    listed = (await client.get(f"{API}/llm-bench-reports?workspaceId={ws}", headers=headers)).json()
    assert len(listed) == 1 and listed[0]["passed"] == 13

    # A different model keeps its own report.
    await client.post(
        f"{API}/llm-bench-reports", headers=headers, json=_report(ws, model="llama3.2:3b")
    )
    listed = (await client.get(f"{API}/llm-bench-reports?workspaceId={ws}", headers=headers)).json()
    assert {r["model"] for r in listed} == {"qwen3.5:4b", "llama3.2:3b"}


async def test_bench_report_keeps_per_case_detail(client):
    """A bare score hides which capability failed, which is what decides
    whether a model is usable."""
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    created = await client.post(f"{API}/llm-bench-reports", headers=headers, json=_report(ws))

    cases = created.json()["cases"]
    assert len(cases) == 1
    assert cases[0]["id"] == "add-tab" and cases[0]["calls"] == ["add_tab"]


async def test_bench_report_delete_and_editor_cannot_write(client, db):
    admin = await _admin(client)
    ws = await _workspace(client, admin)
    rid = (
        await client.post(f"{API}/llm-bench-reports", headers=admin, json=_report(ws))
    ).json()["id"]

    bob_id, bob = await _make_user(db, client, "bob")
    await client.put(
        f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": bob_id, "role": "editor"}
    )
    assert (await client.get(f"{API}/llm-bench-reports?workspaceId={ws}", headers=bob)).status_code == 200
    assert (
        await client.post(f"{API}/llm-bench-reports", headers=bob, json=_report(ws, model="m"))
    ).status_code == 403
    assert (await client.delete(f"{API}/llm-bench-reports/{rid}", headers=bob)).status_code == 403

    assert (await client.delete(f"{API}/llm-bench-reports/{rid}", headers=admin)).status_code == 204
    assert (await client.get(f"{API}/llm-bench-reports?workspaceId={ws}", headers=admin)).json() == []
