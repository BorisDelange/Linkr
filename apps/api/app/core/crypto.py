"""Symmetric encryption for secrets at rest (e.g. external DB passwords).

The Fernet key is derived from ``settings.secret_key`` (the same server secret
that signs JWTs), so there is no extra key to configure — set a strong
``LINKR_SECRET_KEY`` in production and the DB passwords are protected by it.
The plaintext never leaves the server: it is decrypted only to open a database
connection, and the API responses never include the encrypted value.
"""

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


def _fernet() -> Fernet:
    # Fernet needs a 32-byte urlsafe-base64 key; derive it deterministically
    # from the configured secret so rotating secret_key rotates this too.
    digest = hashlib.sha256(settings.secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str | None:
    """Return the plaintext, or None if the token is missing/undecryptable
    (e.g. secret_key changed since it was written)."""
    if not token:
        return None
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return None
