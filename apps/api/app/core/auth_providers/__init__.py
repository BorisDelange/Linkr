"""Pluggable authentication providers.

`authenticate()` returns a User on success or None. Only the local (password)
provider is implemented; LDAP/OIDC/SAML providers will add their own
implementation here and provision Users just-in-time, while the rest of the
auth flow (JWT issuance in routes/auth.py) stays unchanged.
"""

from app.config import settings
from app.core.auth_providers.base import AuthProvider
from app.core.auth_providers.local import LocalAuthProvider

_PROVIDERS: dict[str, AuthProvider] = {
    "local": LocalAuthProvider(),
}


def get_auth_provider() -> AuthProvider:
    provider = _PROVIDERS.get(settings.auth_provider)
    if provider is None:
        raise RuntimeError(
            f"Unknown or unimplemented auth provider: {settings.auth_provider!r}"
        )
    return provider


__all__ = ["AuthProvider", "LocalAuthProvider", "get_auth_provider"]
