"""git_secret: the access token must never survive in the persisted JSON config.

The token is stored per (user, host) by git_credential_service — see
test_git_credential_service — so git_secret's only remaining job is to strip
`authToken` out of a git_remote_config update before it reaches the DB column."""

import types

import pytest

from app.services import git_secret


def test_split_config_pulls_token_out():
    stripped, token = git_secret.split_config(
        {"url": "https://x/y.git", "branch": "main", "authToken": "ghp_secret"}
    )
    assert "authToken" not in stripped
    assert stripped == {"url": "https://x/y.git", "branch": "main"}
    assert token == "ghp_secret"


def test_split_config_none_and_empty():
    assert git_secret.split_config(None) == (None, None)
    assert git_secret.split_config({}) == ({}, None)


def test_apply_strips_token_from_json():
    changes = {"git_remote_config": {"url": "u", "authToken": "tok"}}
    git_secret.apply_to_entity(types.SimpleNamespace(), changes)
    # Token must not survive in the persisted JSON (it never touches the entity).
    assert changes["git_remote_config"] == {"url": "u"}


def test_apply_keeps_tokenless_config():
    changes = {"git_remote_config": {"url": "u2", "branch": "dev"}}
    git_secret.apply_to_entity(types.SimpleNamespace(), changes)
    assert changes["git_remote_config"] == {"url": "u2", "branch": "dev"}


def test_apply_noop_when_config_absent():
    changes = {"name": {"en": "x"}}
    git_secret.apply_to_entity(types.SimpleNamespace(), changes)
    assert changes == {"name": {"en": "x"}}


@pytest.mark.parametrize("url, clean", [
    ("https://oauth2:DUMMY@gitlab.example/r.git", "https://gitlab.example/r.git"),
    ("https://DUMMY@gitlab.example/r.git", "https://gitlab.example/r.git"),
    ("https://gitlab.example/r.git?private_token=DUMMY#frag", "https://gitlab.example/r.git"),
    ("ssh://git:DUMMY@host.example/r.git", "ssh://git@host.example/r.git"),
])
def test_no_credential_stays_in_a_stored_url(url, clean):
    changes = {"git_remote_config": {"url": url, "branch": "main"}}
    git_secret.apply_to_entity(types.SimpleNamespace(), changes)
    assert changes["git_remote_config"] == {"url": clean, "branch": "main"}


@pytest.mark.parametrize("url", [
    "https://gitlab.example/r.git",
    "https://gitlab.example:8443/group/r.git",
    "ssh://git@host.example/r.git",
    "git@host.example:group/r.git",
    "",
])
def test_a_url_without_credentials_is_left_as_written(url):
    assert git_secret.split_config({"url": url}) == ({"url": url}, None)


def test_a_password_in_the_url_comes_back_as_the_token():
    stripped, token = git_secret.split_config({"url": "https://oauth2:a%2Fb@h.example/r.git"})
    assert stripped == {"url": "https://h.example/r.git"}
    assert token == "a/b"
    _, explicit = git_secret.split_config({"url": "https://oauth2:other@h.example/r.git", "authToken": "chosen"})
    assert explicit == "chosen"


def test_a_url_that_cannot_be_parsed_still_loses_its_password():
    stripped, _ = git_secret.split_config({"url": "https://oauth2:DUMMY@[not-a-host/r.git"})
    assert "DUMMY" not in stripped["url"]


async def test_a_stored_url_is_read_back_without_its_credentials(client, seed_roles):
    await client.post("/api/v1/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    login = await client.post("/api/v1/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    h = {"Authorization": f"Bearer {login.json()['access_token']}"}
    ws = (await client.post("/api/v1/workspaces", headers=h, json={"name": {"en": "w"}})).json()
    r = await client.patch(
        f"/api/v1/workspaces/{ws['id']}", headers=h,
        json={"gitRemoteConfig": {"url": "https://oauth2:DUMMY@gitlab.example/r.git", "branch": "main"}},
    )
    assert r.status_code == 200, r.text
    assert "DUMMY" not in r.text
    assert r.json()["gitRemoteConfig"]["url"] == "https://gitlab.example/r.git"
