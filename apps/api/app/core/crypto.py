"""Symmetric encryption for secrets at rest (database passwords, git tokens).

AES-256-GCM with **associated data**: every secret is sealed together with a
``context`` string naming what it belongs to (``db:<user>:<source>:<host>…``).
The context is not stored secretly, but decryption fails unless the exact same
context is supplied. So a ciphertext copied into another user's row, or kept
after a database was pointed at another host, no longer opens.

The key is Linkr's own — never derived from the JWT secret, never stored in the
Linkr database, so a dump or backup of that database alone decrypts nothing.
``LINKR_ENCRYPTION_KEY`` (urlsafe base64 of 32 bytes) wins when set; otherwise a
key is generated on first use into ``data_dir/secret.key`` (mode 0600).
``LINKR_ENCRYPTION_OLD_KEYS`` (comma-separated) keeps rotated-out keys readable:
each ciphertext names the key that sealed it, and `needs_reseal` tells a caller
to rewrite it under the current one.

Token format: ``v2.<key id>.<urlsafe b64 of nonce || ciphertext+tag>``.
"""

import base64
import hashlib
import os
import threading
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import settings

_PREFIX = "v2"
_NONCE_BYTES = 12
_KEY_FILE = "secret.key"

_lock = threading.Lock()
_keyring: tuple[str, dict[str, bytes]] | None = None


def _b64d(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _key_id(key: bytes) -> str:
    return hashlib.sha256(key).hexdigest()[:8]


def _parse_key(value: str) -> bytes:
    key = _b64d(value.strip())
    if len(key) != 32:
        raise RuntimeError("LINKR_ENCRYPTION_KEY must be the urlsafe base64 of 32 bytes")
    return key


def _file_key() -> bytes:
    path: Path = settings.data_path / _KEY_FILE
    if path.is_file():
        return _parse_key(path.read_text())
    key = AESGCM.generate_key(bit_length=256)
    # O_EXCL: two workers booting at once must not each write their own key.
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return _parse_key(path.read_text())
    with os.fdopen(fd, "w") as fh:
        fh.write(_b64e(key))
    return key


def _load_keyring() -> tuple[str, dict[str, bytes]]:
    global _keyring
    with _lock:
        if _keyring is None:
            configured = settings.encryption_key
            current = _parse_key(configured) if configured else _file_key()
            keys = {_key_id(current): current}
            for old in filter(None, (settings.encryption_old_keys or "").split(",")):
                key = _parse_key(old)
                keys.setdefault(_key_id(key), key)
            _keyring = (_key_id(current), keys)
        return _keyring


def reset_keyring() -> None:
    """Forget the loaded keys (tests, or after changing the settings)."""
    global _keyring
    with _lock:
        _keyring = None


def encrypt(plaintext: str, context: str) -> str:
    current_id, keys = _load_keyring()
    nonce = os.urandom(_NONCE_BYTES)
    sealed = AESGCM(keys[current_id]).encrypt(
        nonce, plaintext.encode("utf-8"), context.encode("utf-8")
    )
    return f"{_PREFIX}.{current_id}.{_b64e(nonce + sealed)}"


def decrypt(token: str | None, context: str) -> str | None:
    """The plaintext, or None when the token is missing, sealed for another
    context, or sealed with a key this server no longer has."""
    if not token:
        return None
    try:
        prefix, key_id, body = token.split(".", 2)
    except ValueError:
        return None
    key = _load_keyring()[1].get(key_id)
    if prefix != _PREFIX or key is None:
        return None
    try:
        raw = _b64d(body)
        plain = AESGCM(key).decrypt(
            raw[:_NONCE_BYTES], raw[_NONCE_BYTES:], context.encode("utf-8")
        )
    except (InvalidTag, ValueError):
        return None
    return plain.decode("utf-8")


def needs_reseal(token: str) -> bool:
    """True when `token` was sealed with a rotated-out key."""
    parts = token.split(".", 2)
    return len(parts) == 3 and parts[1] != _load_keyring()[0]


def decrypt_legacy_fernet(token: str, secret_key: str) -> str | None:
    """Open a pre-v2 Fernet token (key derived from the JWT secret). Only the
    migration that re-seals the old secrets calls this."""
    digest = hashlib.sha256(secret_key.encode("utf-8")).digest()
    try:
        return Fernet(base64.urlsafe_b64encode(digest)).decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return None
