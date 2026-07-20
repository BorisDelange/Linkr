"""git_secret: the access token must never survive in the persisted JSON config.

The token is stored per (user, host) by git_credential_service — see
test_git_credential_service — so git_secret's only remaining job is to strip
`authToken` out of a git_remote_config update before it reaches the DB column."""

import types

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
