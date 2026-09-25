"""core/crypto: secrets only open under the context they were sealed with, the
key lives outside the database, and rotated-out keys stay readable."""

import base64
import hashlib
import os
import stat

from cryptography.fernet import Fernet

from app.config import settings
from app.core import crypto


def _key() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode()


def test_roundtrip():
    token = crypto.encrypt("s3cret", "db:1:src")
    assert "s3cret" not in token
    assert crypto.decrypt(token, "db:1:src") == "s3cret"


def test_nonce_makes_every_token_different():
    assert crypto.encrypt("same", "ctx") != crypto.encrypt("same", "ctx")


def test_other_context_does_not_open():
    """A ciphertext moved to another user's row, or kept after the host
    changed, is useless."""
    token = crypto.encrypt("s3cret", "db:1:src:host-a")
    assert crypto.decrypt(token, "db:2:src:host-a") is None
    assert crypto.decrypt(token, "db:1:src:host-b") is None


def test_tampered_or_garbage_token():
    token = crypto.encrypt("s3cret", "ctx")
    tampered = token[:-2] + ("A" if token[-2] != "A" else "B") + token[-1]
    assert crypto.decrypt(tampered, "ctx") is None
    assert crypto.decrypt("not-a-token", "ctx") is None
    assert crypto.decrypt(None, "ctx") is None
    assert crypto.decrypt("", "ctx") is None


def test_key_file_generated_private_and_stable():
    token = crypto.encrypt("s3cret", "ctx")
    path = settings.data_path / "secret.key"
    assert path.is_file()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    crypto.reset_keyring()
    assert crypto.decrypt(token, "ctx") == "s3cret"


def test_env_key_wins_over_file(monkeypatch):
    monkeypatch.setattr(settings, "encryption_key", _key())
    crypto.reset_keyring()
    crypto.encrypt("x", "ctx")
    assert not (settings.data_path / "secret.key").exists()


def test_rotation_keeps_old_tokens_readable(monkeypatch):
    old, new = _key(), _key()
    monkeypatch.setattr(settings, "encryption_key", old)
    crypto.reset_keyring()
    token = crypto.encrypt("s3cret", "ctx")
    assert not crypto.needs_reseal(token)

    monkeypatch.setattr(settings, "encryption_key", new)
    monkeypatch.setattr(settings, "encryption_old_keys", old)
    crypto.reset_keyring()
    assert crypto.decrypt(token, "ctx") == "s3cret"
    assert crypto.needs_reseal(token)
    assert not crypto.needs_reseal(crypto.encrypt("s3cret", "ctx"))

    monkeypatch.setattr(settings, "encryption_old_keys", "")
    crypto.reset_keyring()
    assert crypto.decrypt(token, "ctx") is None


def test_legacy_fernet_is_readable_for_the_migration():
    digest = hashlib.sha256(b"jwt-secret").digest()
    legacy = Fernet(base64.urlsafe_b64encode(digest)).encrypt(b"old").decode()
    assert crypto.decrypt_legacy_fernet(legacy, "jwt-secret") == "old"
    assert crypto.decrypt_legacy_fernet(legacy, "other") is None
