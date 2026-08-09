"""Relaying assistant requests to a model.

The proxy exists so an API key can stay encrypted server-side. What must hold:
the key is added server-side and never exposed, only configured providers can be
reached (not an arbitrary URL), and the acknowledgement gate applies here too —
enforcing it only on write would leave the actual data path open.
"""

import httpx
import pytest

from app.config import settings
from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"

LOCAL = "http://localhost:11434/v1"
REMOTE = "https://api.mistral.ai/v1"


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


async def _provider(client, headers, ws: str, **overrides) -> dict:
    payload = {
        "workspaceId": ws,
        "baseUrl": LOCAL,
        "model": "qwen3.5:4b",
        "surfaces": ["dashboard"],
    }
    payload.update(overrides)
    return (await client.post(f"{API}/llm-providers", headers=headers, json=payload)).json()


@pytest.fixture
def upstream(monkeypatch):
    """Capture what the proxy sends upstream, without a real model."""
    calls: list[dict] = []

    class _Response:
        status_code = 200
        content = b'{"choices":[{"message":{"content":"ok"}}]}'
        headers = {"content-type": "application/json"}

    class _Client:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        async def post(self, url, headers=None, json=None):
            calls.append({"url": url, "headers": headers or {}, "json": json or {}})
            return _Response()

    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    return calls


async def test_proxy_adds_the_key_server_side(client, upstream):
    """The whole point: the browser never holds the credential."""
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    provider = await _provider(client, headers, ws, apiKey="sk-secret-value")

    r = await client.post(
        f"{API}/llm-providers/{provider['id']}/chat",
        headers=headers,
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert r.status_code == 200
    assert upstream[0]["headers"]["Authorization"] == "Bearer sk-secret-value"
    assert upstream[0]["url"] == f"{LOCAL}/chat/completions"


async def test_proxy_sends_no_auth_header_when_there_is_no_key(client, upstream):
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    provider = await _provider(client, headers, ws)

    await client.post(
        f"{API}/llm-providers/{provider['id']}/chat",
        headers=headers,
        json={"messages": []},
    )
    assert "Authorization" not in upstream[0]["headers"]


async def test_a_local_endpoint_can_carry_a_key_too(client, upstream):
    """vLLM or LiteLLM behind a reverse proxy needs a token without any of the
    remote-data warnings applying."""
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    provider = await _provider(client, headers, ws, apiKey="local-token")
    assert provider["isLocal"] is True

    await client.post(
        f"{API}/llm-providers/{provider['id']}/chat", headers=headers, json={"messages": []}
    )
    assert upstream[0]["headers"]["Authorization"] == "Bearer local-token"


async def test_the_model_comes_from_the_provider_not_the_client(client, upstream):
    """Per-surface approval is meaningless if a user can name another model."""
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    provider = await _provider(client, headers, ws, model="qwen3.5:4b")

    await client.post(
        f"{API}/llm-providers/{provider['id']}/chat",
        headers=headers,
        json={"messages": [], "model": "some-other-model"},
    )
    assert upstream[0]["json"]["model"] == "qwen3.5:4b"


async def test_unacknowledged_remote_provider_is_refused(client, db, upstream, monkeypatch):
    """The acknowledgement gate must hold on the data path, not only on write —
    otherwise a row that never got one is still reachable."""
    monkeypatch.setattr(settings, "allow_remote_llm", True)
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    provider = await _provider(
        client, headers, ws, baseUrl=REMOTE, acknowledgementText="I accept"
    )
    assert provider["acknowledgedAt"] is not None

    # Acknowledged: it goes through.
    ok = await client.post(
        f"{API}/llm-providers/{provider['id']}/chat", headers=headers, json={"messages": []}
    )
    assert ok.status_code == 200

    from sqlalchemy import update

    from app.models.llm_provider import LlmProvider

    await db.execute(
        update(LlmProvider)
        .where(LlmProvider.id == provider["id"])
        .values(acknowledged_at=None)
    )
    await db.commit()

    refused = await client.post(
        f"{API}/llm-providers/{provider['id']}/chat", headers=headers, json={"messages": []}
    )
    assert refused.status_code == 403


async def test_disabled_provider_is_refused(client, upstream):
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    provider = await _provider(client, headers, ws, enabled=False)

    r = await client.post(
        f"{API}/llm-providers/{provider['id']}/chat", headers=headers, json={"messages": []}
    )
    assert r.status_code == 403
    assert not upstream


async def test_non_member_cannot_reach_the_model(client, db, upstream):
    """Otherwise the proxy is an open relay to a workspace's paid API."""
    admin = await _admin(client)
    ws = await _workspace(client, admin)
    provider = await _provider(client, admin, ws)
    _, mallory = await _make_user(db, client, "mallory")

    r = await client.post(
        f"{API}/llm-providers/{provider['id']}/chat", headers=mallory, json={"messages": []}
    )
    assert r.status_code == 403
    assert not upstream


async def test_an_editor_may_use_the_model_without_configuring_it(client, db, upstream):
    """Using the assistant needs read, not the owner-only write."""
    admin = await _admin(client)
    ws = await _workspace(client, admin)
    provider = await _provider(client, admin, ws)
    bob_id, bob = await _make_user(db, client, "bob")
    await client.put(
        f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": bob_id, "role": "editor"}
    )

    r = await client.post(
        f"{API}/llm-providers/{provider['id']}/chat", headers=bob, json={"messages": []}
    )
    assert r.status_code == 200


async def test_unknown_provider_is_404(client, upstream):
    headers = await _admin(client)
    r = await client.post(
        f"{API}/llm-providers/does-not-exist/chat", headers=headers, json={"messages": []}
    )
    assert r.status_code == 404
    assert not upstream


async def test_anonymous_request_is_rejected(client, upstream):
    r = await client.post(f"{API}/llm-providers/whatever/chat", json={"messages": []})
    assert r.status_code in (401, 403)
    assert not upstream


async def test_a_stored_url_pointed_at_metadata_is_refused_at_proxy_time(client, db, upstream):
    """The write-time guard blocks IMDS, but the URL could be edited around it or
    predate the check. The proxy re-validates, so the SSRF target is never hit."""
    from sqlalchemy import select

    from app.models.llm_provider import LlmProvider

    headers = await _admin(client)
    ws = await _workspace(client, headers)
    provider = await _provider(client, headers, ws)

    row = (
        await db.scalars(select(LlmProvider).where(LlmProvider.id == provider["id"]))
    ).one()
    row.base_url = "http://169.254.169.254/latest/meta-data"
    await db.commit()

    r = await client.post(
        f"{API}/llm-providers/{provider['id']}/chat", headers=headers, json={"messages": []}
    )
    assert r.status_code == 403
    assert not upstream


async def test_a_non_object_body_is_a_400_not_a_500(client, upstream):
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    provider = await _provider(client, headers, ws)

    r = await client.post(
        f"{API}/llm-providers/{provider['id']}/chat", headers=headers, json="hi"
    )
    assert r.status_code == 400
    assert not upstream


async def test_creating_a_metadata_provider_is_rejected(client):
    headers = await _admin(client)
    ws = await _workspace(client, headers)
    r = await client.post(
        f"{API}/llm-providers",
        headers=headers,
        json={
            "workspaceId": ws,
            "baseUrl": "http://169.254.169.254/latest/meta-data",
            "model": "x",
            "surfaces": ["dashboard"],
        },
    )
    assert r.status_code == 400
