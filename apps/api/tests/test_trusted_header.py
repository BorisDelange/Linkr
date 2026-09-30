"""Sign-in by a header the front proxy sets (security plan E). Believed only on a
request from a configured proxy address; names an existing, active user."""

import pytest

from app.config import settings
from app.core import audit
from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"
HEADER = {"X-Remote-User": "alice"}


@pytest.fixture
def trusted(monkeypatch):
    def _set(proxies: str, header: str = "X-Remote-User"):
        monkeypatch.setattr(settings, "trusted_header", header)
        monkeypatch.setattr(settings, "trusted_proxies", proxies)
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


@pytest.mark.parametrize("headers", [{}, {"X-Remote-User": "  "}, {"X-Remote-User": "mallory"}])
async def test_no_or_unknown_identity_is_refused(client, db, trusted, headers):
    await _alice(db)
    trusted("127.0.0.1")
    assert (await client.post(f"{API}/auth/trusted-login", headers=headers)).status_code == 401


async def test_a_disabled_user_is_refused(client, db, trusted):
    await _alice(db, active=False)
    trusted("127.0.0.1")
    assert (await client.post(f"{API}/auth/trusted-login", headers=HEADER)).status_code == 401
