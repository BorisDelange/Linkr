"""git_credential_service: git tokens are stored per (user, host), encrypted at
rest, and one user's token is never reachable by another user."""

import pytest

from app.core.security import hash_password
from app.models.git_credential import GitCredential
from app.models.user import User
from app.services import git_credential_service as svc


async def _user(db, username: str) -> User:
    u = User(username=username, password_hash=hash_password("pw"), role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://gitlab.com/group/repo.git", "gitlab.com"),
        ("https://framagit.org/interhop/linkr/linkr", "framagit.org"),
        ("http://GitLab.COM/x", "gitlab.com"),
        ("git@github.com:owner/repo.git", "github.com"),
        ("ssh://git@gitea.local:3000/owner/repo.git", "gitea.local:3000"),
        ("https://host:8443/x", "host:8443"),
        ("https://host:443/x", "host"),  # default https port dropped
        ("", None),
        ("not a url", None),
    ],
)
def test_host_of(url, expected):
    assert svc.host_of(url) == expected


async def test_set_get_roundtrip_is_encrypted(db):
    user = await _user(db, "alice")
    await svc.set_token_for_url(db, user, "https://gitlab.com/a/b.git", "glpat-secret")

    # Round-trips for the same host / any repo on it.
    assert await svc.token_for_url(db, user, "https://gitlab.com/other/repo") == "glpat-secret"
    assert await svc.token_for_host(db, user, "gitlab.com") == "glpat-secret"
    assert await svc.has_token_for_host(db, user, "gitlab.com") is True

    # Stored ciphertext is not the plaintext.
    row = (await db.execute(
        __import__("sqlalchemy").select(GitCredential).where(GitCredential.user_id == user.id)
    )).scalar_one()
    assert row.secret != "glpat-secret"


async def test_one_user_cannot_read_anothers_token(db):
    alice = await _user(db, "alice")
    bob = await _user(db, "bob")
    await svc.set_token(db, alice, "gitlab.com", "alice-token")

    # Bob has nothing on that host, even though Alice does.
    assert await svc.token_for_host(db, bob, "gitlab.com") is None
    assert await svc.has_token_for_host(db, bob, "gitlab.com") is False


async def test_update_overwrites_and_empty_clears(db):
    user = await _user(db, "carol")
    await svc.set_token(db, user, "gitlab.com", "first")
    await svc.set_token(db, user, "gitlab.com", "second")
    assert await svc.token_for_host(db, user, "gitlab.com") == "second"

    # Empty token clears the credential (unlink).
    await svc.set_token(db, user, "gitlab.com", "")
    assert await svc.token_for_host(db, user, "gitlab.com") is None
    assert await svc.has_token_for_host(db, user, "gitlab.com") is False


async def test_token_for_url_without_host_is_none(db):
    user = await _user(db, "dave")
    assert await svc.token_for_url(db, user, None) is None
    assert await svc.token_for_url(db, user, "not a url") is None
