"""Sign-in by a header the front proxy sets (security plan E). Believed only on a
request from a configured proxy address that carries the proxy's shared secret;
names an existing, active user."""

import pytest

from app.config import settings
from app.core import audit, trusted_header
from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"
SECRET = "s" * 40
HEADER = {"X-Remote-User": "alice", "X-Linkr-Proxy-Secret": SECRET}


@pytest.fixture
def trusted(monkeypatch):
    def _set(proxies: str, header: str = "X-Remote-User", secret: str = SECRET):
        monkeypatch.setattr(settings, "trusted_header", header)
        monkeypatch.setattr(settings, "trusted_proxies", proxies)
        monkeypatch.setattr(settings, "trusted_proxy_secret", secret)
    return _set


async def _alice(db, active=True):
    db.add(User(username="alice", password_hash=hash_password("pw"), role="user", is_active=active))
    await db.commit()


async def test_off_by_default(client, db):
    await _alice(db)
    assert (await client.post(f"{API}/auth/trusted-login", headers=HEADER)).status_code == 404
    assert (await client.get(f"{API}/setup/status")).json()["trusted_header_login"] is False


async def test_a_trusted_proxy_signs_the_named_user_in(client, db, trusted):
    await _alice(db)
    trusted("10.0.0.0/8, 127.0.0.1")  # the test client's peer is 127.0.0.1
    assert (await client.get(f"{API}/setup/status")).json()["trusted_header_login"] is True
    r = await client.post(f"{API}/auth/trusted-login", headers=HEADER)
    assert r.status_code == 200 and r.json()["user"]["username"] == "alice"
    me = await client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"})
    assert me.json()["username"] == "alice"
    login = audit.query(filters={"action": ["login"]})[0]
    assert login[0]["username"] == "alice" and login[0]["via"] == "trusted_header"


async def test_the_header_is_not_believed_from_anywhere_else(client, db, trusted):
    await _alice(db)
    trusted("10.9.9.9")
    assert (await client.post(f"{API}/auth/trusted-login", headers=HEADER)).status_code == 401


@pytest.mark.parametrize("secret", [None, "", "wrong", SECRET[:-1], SECRET + "x"])
async def test_a_trusted_peer_without_the_secret_is_refused(client, db, trusted, secret):
    """Behind the image's nginx every request, a kernel's included, comes from
    the trusted peer: only the secret tells the gateway apart."""
    await _alice(db)
    trusted("127.0.0.1")
    headers = {"X-Remote-User": "alice"}
    if secret is not None:
        headers["X-Linkr-Proxy-Secret"] = secret
    assert (await client.post(f"{API}/auth/trusted-login", headers=headers)).status_code == 401


@pytest.mark.parametrize("secret", ["", "short", "x" * 31])
async def test_no_usable_secret_keeps_the_feature_off(client, db, trusted, secret):
    await _alice(db)
    trusted("127.0.0.1", secret=secret)
    assert trusted_header.configuration_error() is not None
    assert (await client.get(f"{API}/setup/status")).json()["trusted_header_login"] is False
    r = await client.post(f"{API}/auth/trusted-login", headers={**HEADER, "X-Linkr-Proxy-Secret": secret})
    assert r.status_code == 404


def test_configuration_error_only_when_the_header_is_set(monkeypatch):
    monkeypatch.setattr(settings, "trusted_header", "")
    monkeypatch.setattr(settings, "trusted_proxy_secret", "")
    assert trusted_header.configuration_error() is None
    monkeypatch.setattr(settings, "trusted_header", "X-Remote-User")
    monkeypatch.setattr(settings, "trusted_proxies", "")
    monkeypatch.setattr(settings, "trusted_proxy_secret", SECRET)
    assert "LINKR_TRUSTED_PROXIES" in trusted_header.configuration_error()


@pytest.mark.parametrize("headers", [
    {"X-Linkr-Proxy-Secret": SECRET},
    {"X-Remote-User": "  ", "X-Linkr-Proxy-Secret": SECRET},
    {"X-Remote-User": "mallory", "X-Linkr-Proxy-Secret": SECRET},
])
async def test_no_or_unknown_identity_is_refused(client, db, trusted, headers):
    await _alice(db)
    trusted("127.0.0.1")
    assert (await client.post(f"{API}/auth/trusted-login", headers=headers)).status_code == 401


async def test_a_disabled_user_is_refused(client, db, trusted):
    await _alice(db, active=False)
    trusted("127.0.0.1")
    assert (await client.post(f"{API}/auth/trusted-login", headers=HEADER)).status_code == 401
