"""Sign-in by a header the front proxy sets (settings.trusted_header).

The proxy has already authenticated the person — in an SPE, with two factors —
and passes who they are. Believing that header is only safe for a request that
really came through the proxy. The peer address alone cannot prove it: behind
the image's nginx every request comes from nginx, including one a kernel sends
to it. So the proxy also sends a shared secret (settings.trusted_proxy_secret)
that nothing else holds. Linkr maps the name to an existing, active user; it
never creates one here.
"""

import hmac
import ipaddress

from app.config import settings

SECRET_HEADER = "X-Linkr-Proxy-Secret"
MIN_SECRET_LENGTH = 32


def configuration_error() -> str | None:
    """Why the trusted-header settings cannot be used, or None when they can (or
    the feature is simply off)."""
    if not settings.trusted_header.strip():
        return None
    if not settings.trusted_proxies.strip():
        return "LINKR_TRUSTED_HEADER is set without LINKR_TRUSTED_PROXIES."
    if len(settings.trusted_proxy_secret.strip()) < MIN_SECRET_LENGTH:
        return (
            f"LINKR_TRUSTED_HEADER is set without a LINKR_TRUSTED_PROXY_SECRET of at least "
            f"{MIN_SECRET_LENGTH} characters, which the front proxy must send in {SECRET_HEADER}."
        )
    return None


def enabled() -> bool:
    return bool(settings.trusted_header.strip()) and configuration_error() is None


def from_trusted_proxy(peer: str | None) -> bool:
    if not peer:
        return False
    try:
        ip = ipaddress.ip_address(peer)
    except ValueError:
        return False
    for entry in settings.trusted_proxies.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            if ip in ipaddress.ip_network(entry, strict=False):
                return True
        except ValueError:
            continue
    return False


def _carries_secret(headers) -> bool:
    sent = headers.get(SECRET_HEADER) or ""
    return hmac.compare_digest(sent.strip().encode(), settings.trusted_proxy_secret.strip().encode())


def username(headers, peer: str | None) -> str | None:
    """The user the proxy vouches for, or None when it does not (feature off,
    request not from a trusted proxy or without its secret, header absent or blank)."""
    if not enabled() or not from_trusted_proxy(peer) or not _carries_secret(headers):
        return None
    value = headers.get(settings.trusted_header.strip())
    return value.strip() if value and value.strip() else None
