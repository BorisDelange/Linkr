"""git_secret: the access token must never survive in the JSON config, and
editing url/branch must not silently wipe a stored credential."""

import types

from app.core import crypto
from app.services import git_secret


def _entity():
    return types.SimpleNamespace(git_remote_secret=None)


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


def test_apply_encrypts_token_and_strips_it_from_json():
    entity = _entity()
    changes = {"git_remote_config": {"url": "u", "authToken": "tok"}}
    git_secret.apply_to_entity(entity, changes)
    # token gone from the persisted JSON, encrypted on the entity
    assert changes["git_remote_config"] == {"url": "u"}
    assert entity.git_remote_secret and entity.git_remote_secret != "tok"
    assert crypto.decrypt(entity.git_remote_secret) == "tok"


def test_apply_without_token_leaves_stored_secret_untouched():
    entity = _entity()
    entity.git_remote_secret = crypto.encrypt("existing")
    changes = {"git_remote_config": {"url": "u2", "branch": "dev"}}
    git_secret.apply_to_entity(entity, changes)
    assert crypto.decrypt(entity.git_remote_secret) == "existing"
    assert changes["git_remote_config"] == {"url": "u2", "branch": "dev"}


def test_apply_empty_config_clears_the_secret():
    entity = _entity()
    entity.git_remote_secret = crypto.encrypt("existing")
    changes = {"git_remote_config": {}}
    git_secret.apply_to_entity(entity, changes)
    assert entity.git_remote_secret is None


def test_apply_noop_when_config_absent():
    entity = _entity()
    entity.git_remote_secret = crypto.encrypt("keep")
    changes = {"name": {"en": "x"}}
    git_secret.apply_to_entity(entity, changes)
    assert crypto.decrypt(entity.git_remote_secret) == "keep"


def test_token_for_roundtrip():
    entity = _entity()
    entity.git_remote_secret = crypto.encrypt("abc")
    assert git_secret.token_for(entity) == "abc"
    assert git_secret.token_for(_entity()) is None
