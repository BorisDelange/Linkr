"""On a key a shipped example names, an instance starts but serves nothing, and says why;
a short key only warns."""

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.testclient import TestClient, WebSocketDenialResponse

from app import main
from app.config import settings
from app.core import example_secret

EXAMPLE_KEYS = [
    "dev-secret-change-in-production",
    "change-me",
    "CHANGE-ME",
    " changeme ",
    "",
    "   ",
    '"change-me"',
    "''",
    "<the generated secret>",
]


@pytest.mark.parametrize(
    "key", ["change-me", "CHANGE-ME", "dev-secret-change-in-production", "short", ""]
)
def test_a_known_or_short_signing_key_is_weak(key):
    assert main.weak_secret_key(key)


@pytest.mark.parametrize("key", ['"suitably-long-random-looking-value-0123456789"', "change-me-please-0123456789abcdef"])
def test_a_real_key_is_no_example_even_quoted_or_containing_one(key):
    assert not example_secret.is_example(key)


def test_a_generated_signing_key_is_not():
    assert not main.weak_secret_key("suitably-long-random-looking-value-0123456789")


@pytest.fixture
def example_key(monkeypatch, request):
    monkeypatch.setattr(settings, "secret_key", request.param)
    monkeypatch.setattr(settings, "debug", False)


def _no_signature(monkeypatch):
    def refused(*_args, **_kwargs):
        raise AssertionError("a token was signed or verified")

    for name in ("encode", "decode"):
        monkeypatch.setattr(f"app.core.security.jwt.{name}", refused)


@pytest.mark.parametrize("example_key", EXAMPLE_KEYS, indirect=True)
async def test_on_an_example_key_the_app_starts_and_only_its_health_answers(
    example_key, monkeypatch
):
    errors = []
    monkeypatch.setattr(main.logger, "error", lambda event, **_: errors.append(event))
    monkeypatch.setattr(main, "run_migrations", lambda: pytest.fail("migrations ran"))
    async with main.lifespan(main.app):
        pass
    assert errors == ["insecure_secret_key"]

    _no_signature(monkeypatch)
    async with AsyncClient(
        transport=ASGITransport(app=main.app), base_url="http://test"
    ) as client:
        health = await client.get("/api/v1/health")
        assert health.status_code == 200
        assert health.json()["status"] == "refusing"
        assert health.json()["refusal"]["code"] == "insecure_secret_key"
        for method, path, body in (
            ("GET", "/api/v1/setup/status", None),
            (
                "POST",
                "/api/v1/setup/initialize",
                {"username": "admin", "password": "pw-for-tests-only"},
            ),
            (
                "POST",
                "/api/v1/auth/login",
                {"username": "admin", "password": "pw-for-tests-only"},
            ),
            ("GET", "/api/v1/projects", None),
            ("POST", "/api/v1/projects", {"name": "x" * 2_000_000}),
            ("GET", "/docs", None),
            ("GET", "/openapi.json", None),
        ):
            r = await client.request(
                method, path, json=body, headers={"Authorization": "Bearer forged"}
            )
            assert r.status_code == 503, path
            assert r.json()["detail"]["code"] == "insecure_secret_key", path
            assert "LINKR_SECRET_KEY" in r.json()["detail"]["message"]


@pytest.mark.parametrize("example_key", ["change-me"], indirect=True)
def test_on_an_example_key_a_websocket_is_refused_before_it_opens(
    example_key, monkeypatch
):
    _no_signature(monkeypatch)
    with (
        pytest.raises(WebSocketDenialResponse) as refused,
        TestClient(main.app).websocket_connect("/api/v1/notifications/ws?token=forged"),
    ):
        pass
    assert refused.value.status_code == 503
    assert refused.value.json()["detail"]["code"] == "insecure_secret_key"


@pytest.mark.parametrize("example_key", ["change-me"], indirect=True)
async def test_a_browser_on_another_origin_can_read_the_refusal(example_key):
    origin = next(o for o in settings.cors_origin_list if o != "*")
    async with AsyncClient(
        transport=ASGITransport(app=main.app), base_url="http://test"
    ) as client:
        r = await client.get("/api/v1/setup/status", headers={"Origin": origin})
    assert r.status_code == 503
    assert r.headers["access-control-allow-origin"] == origin


async def test_a_debug_run_serves_on_an_example_key(client, monkeypatch):
    monkeypatch.setattr(settings, "secret_key", "change-me")
    monkeypatch.setattr(settings, "debug", True)
    assert (await client.get("/api/v1/health")).json()["status"] == "ok"
    assert (await client.get("/api/v1/setup/status")).status_code == 200


@pytest.mark.parametrize("key", ["a-key-of-15-char", "short"])
async def test_an_instance_running_on_a_short_key_still_serves_and_is_warned(
    client, monkeypatch, key
):
    class Reached(Exception):
        pass

    def stop_after_the_check():
        raise Reached

    warned = []
    monkeypatch.setattr(settings, "secret_key", key)
    monkeypatch.setattr(settings, "debug", False)
    monkeypatch.setattr(
        main.trusted_header, "configuration_error", stop_after_the_check
    )
    monkeypatch.setattr(main.logger, "warning", lambda event, **_: warned.append(event))
    with pytest.raises(Reached):
        async with main.lifespan(main.app):
            pass
    assert "weak_secret_key" in warned
    assert (await client.get("/api/v1/health")).json()["status"] == "ok"
    assert (await client.get("/api/v1/setup/status")).status_code == 200
