"""Sign-in by a header the front proxy sets (settings.trusted_header).

The proxy has already authenticated the person — in an SPE, with two factors —
and passes who they are. Believing that header is only safe for a request that
really came through the proxy, so the peer address must be a configured one.
Linkr maps the name to an existing, active user; it never creates one here.
"""

import ipaddress

from app.config import settings


def enabled() -> bool:
    return bool(settings.trusted_header.strip() and settings.trusted_proxies.strip())


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


def username(headers, peer: str | None) -> str | None:
    """The user the proxy vouches for, or None when it does not (feature off,
    request not from a trusted proxy, header absent or blank)."""
    if not enabled() or not from_trusted_proxy(peer):
        return None
    value = headers.get(settings.trusted_header.strip())
    return value.strip() if value and value.strip() else None
