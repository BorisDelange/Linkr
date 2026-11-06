"""What proves that whoever creates the first administrator can reach the server.

Before any account exists, the setup page answers anyone who reaches it. The token
only exists in the server's own log or configuration, so holding it means holding
access to the machine. Without a lifespan (the API mounted in a test) nothing asks.
"""

import secrets

from app.config import settings

_token: str | None = None


def arm() -> bool:
    """Set the token for this boot. True if it was generated, and has to be shown."""
    global _token
    _token = settings.setup_token or secrets.token_urlsafe(24)
    return not settings.setup_token


def current() -> str | None:
    return _token


def matches(candidate: str | None) -> bool:
    if _token is None:
        return True
    return secrets.compare_digest((candidate or "").encode("utf-8", "surrogatepass"), _token.encode())
