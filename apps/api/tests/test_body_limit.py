"""A body is refused by size before anything buffers or parses it, on the routes
that would read it whole; the routes that stream or spool theirs stay unlimited."""

import pytest

from app.config import settings
from app.core.body_limit import _routes_reading_whole_body
from app.main import app

API = "/api/v1"
MB = 1024 * 1024


async def _chunks(total: int):
    for _ in range(total // MB):
        yield b" " * MB


@pytest.mark.parametrize("path", ["/auth/login", "/setup/initialize"])
async def test_sign_in_routes_take_small_bodies_only(client, path):
    r = await client.post(f"{API}{path}", content=b" " * (2 * MB), headers={"content-type": "application/json"})
    assert r.status_code == 413


async def test_size_is_counted_without_a_declared_length(client):
    r = await client.post(f"{API}/auth/login", content=_chunks(3 * MB), headers={"content-type": "application/json"})
    assert r.status_code in (400, 413)


async def test_content_type_does_not_change_the_limit(client):
    r = await client.post(f"{API}/auth/login", content=b"x" * (2 * MB), headers={"content-type": "multipart/form-data; boundary=x"})
    assert r.status_code == 413


async def test_small_body_reaches_the_route(client):
    r = await client.post(f"{API}/auth/login", json={"username": "nobody", "password": "not-a-real-one"})
    assert r.status_code == 401


async def test_json_route_is_limited_before_authentication(client, monkeypatch):
    monkeypatch.setattr(settings, "max_json_body_mb", 2)
    big = b" " * (3 * MB)
    r = await client.post(f"{API}/workspaces", content=big, headers={"content-type": "application/json"})
    assert r.status_code == 401
    r = await client.post(f"{API}/workspaces", content=b"{}", headers={"content-type": "application/json"})
    assert r.status_code == 401


async def test_raw_upload_routes_are_not_limited_here(client, monkeypatch):
    monkeypatch.setattr(settings, "max_json_body_mb", 1)
    big = b"x" * (2 * MB)
    r = await client.post(f"{API}/readme-attachments", content=big, params={"id": "a", "ownerType": "project", "ownerId": "p", "fileName": "f"})
    assert r.status_code != 413
    r = await client.put(f"{API}/uploads/some-id/chunks/0", content=big)
    assert r.status_code != 413


def test_multipart_and_streaming_routes_are_not_classed_as_whole_body():
    routes = _routes_reading_whole_body(app)

    def classed(method, path):
        return any(m == method and regex.match(path) for m, regex in routes)

    assert classed("POST", f"{API}/workspaces")
    assert not classed("POST", f"{API}/git/projects/p/commit-push")


@pytest.mark.parametrize("authorization", [None, "Bearer not.a.jwt", "Bearer lnk_invalid"])
async def test_a_large_body_needs_a_valid_credential_before_it_is_read(client, authorization):
    headers = {"content-type": "application/json", **({"authorization": authorization} if authorization else {})}
    body = b"[" + b"{}," * (MB // 3 * 2) + b"{}]"
    assert len(body) > MB
    r = await client.post(f"{API}/uploads", content=body, headers=headers)
    assert r.status_code == 401
    streamed = await client.post(f"{API}/uploads", content=_chunks(2 * MB), headers=headers)
    assert streamed.status_code in (400, 413)


async def test_a_large_body_with_a_valid_credential_reaches_the_route(client, monkeypatch):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    token = (await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})).json()["access_token"]
    session = {"authorization": f"Bearer {token}"}
    key = (await client.post(f"{API}/auth/api-tokens", headers=session, json={"name": "k"})).json()["token"]
    body = b" " * (2 * MB) + b"{}"
    for authorization in (session["authorization"], f"Bearer {key}"):
        r = await client.post(f"{API}/workspaces", content=body,
                              headers={"content-type": "application/json", "authorization": authorization})
        assert r.status_code == 422
    monkeypatch.setattr(settings, "max_json_body_mb", 2)
    r = await client.post(f"{API}/workspaces", content=b" " * (3 * MB),
                          headers={"content-type": "application/json", **session})
    assert r.status_code == 413
