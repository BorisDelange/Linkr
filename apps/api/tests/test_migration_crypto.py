"""Migration c4d5e6f7a8b9 vendors the crypto it re-seals secrets with, so a
later change to core/crypto cannot change what it does. Pinned here: its output
is exactly what crypto.py writes and reads today."""

import base64
import hashlib
import importlib.util
from pathlib import Path

from cryptography.fernet import Fernet

from app.config import settings
from app.core import crypto

_PATH = Path(__file__).parent.parent / "alembic" / "versions" / "c4d5e6f7a8b9_per_user_database_credentials.py"
_spec = importlib.util.spec_from_file_location("migration_c4d5e6f7a8b9", _PATH)
migration = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migration)


def _key() -> bytes:
    return migration._current_key(settings.encryption_key, settings.data_path / "secret.key")


def test_a_key_file_created_by_the_migration_is_the_one_the_app_uses():
    assert not (settings.data_path / "secret.key").exists()
    key = _key()
    assert crypto._load_keyring() == (hashlib.sha256(key).hexdigest()[:8], {hashlib.sha256(key).hexdigest()[:8]: key})
    assert _key() == key


def test_the_env_key_wins(monkeypatch):
    raw = base64.urlsafe_b64encode(b"k" * 32).decode().rstrip("=")
    monkeypatch.setattr(settings, "encryption_key", raw)
    assert _key() == b"k" * 32 == crypto._load_keyring()[1][crypto._load_keyring()[0]]


def test_sealed_tokens_are_byte_identical_and_open_in_the_app(monkeypatch):
    key = _key()
    monkeypatch.setattr("os.urandom", lambda n: b"\x01" * n)
    ours = migration._seal("tok€n", "git:1:gitlab.com", key)
    assert ours == crypto.encrypt("tok€n", "git:1:gitlab.com")
    monkeypatch.undo()
    assert crypto.decrypt(migration._seal("s", "ide:abc", key), "ide:abc") == "s"
    assert crypto.decrypt(migration._seal("s", "ide:abc", key), "ide:other") is None


def test_legacy_fernet_opens_the_same():
    digest = hashlib.sha256(settings.secret_key.encode()).digest()
    token = Fernet(base64.urlsafe_b64encode(digest)).encrypt("old".encode()).decode()
    assert migration._legacy_fernet_decrypt(token, settings.secret_key) == "old"
    assert crypto.decrypt_legacy_fernet(token, settings.secret_key) == "old"
    assert migration._legacy_fernet_decrypt(token, "another-secret") is None
    assert migration._legacy_fernet_decrypt("garbage", settings.secret_key) is None
