"""Which hosts the server may open a database connection to.

Connecting is a network request made from inside the deployment: without a
bound, anyone who can describe a database can use the server to probe the
internal network (in an SPE, the warehouse's own). Private addresses cannot be
refused outright — that is exactly where a datamart lives — so the bound is an
allowlist the deployment sets (LINKR_DB_ALLOWED_HOSTS). Empty = no restriction.
"""

import ipaddress
import socket

from app.config import settings


class DbHostNotAllowed(ValueError):
    pass


def _entries() -> tuple[set[str], list[ipaddress._BaseNetwork]]:
    names: set[str] = set()
    networks: list[ipaddress._BaseNetwork] = []
    for raw in settings.db_allowed_hosts.split(","):
        entry = raw.strip()
        if not entry:
            continue
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            names.add(entry.lower())
    return names, networks


def _resolves_inside(host: str, networks: list[ipaddress._BaseNetwork]) -> bool:
    try:
        return any(ipaddress.ip_address(host) in net for net in networks)
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except OSError:
        return False
    ips = {ipaddress.ip_address(info[4][0].split("%")[0]) for info in infos}
    return bool(ips) and all(any(ip in net for net in networks) for ip in ips)


def check_db_host(host: str | None) -> None:
    """Raise DbHostNotAllowed unless every host in `host` is allowlisted — by
    name, or by all of its resolved addresses falling in an allowed network.
    libpq takes a comma-separated host list and a socket directory as a host;
    no host at all means the local socket."""
    names, networks = _entries()
    if not names and not networks:
        return
    for part in (host or "").split(","):
        h = part.strip().lower()
        if not h:
            h = "localhost"
        if h in names:
            continue
        if not h.startswith("/") and _resolves_inside(h, networks):
            continue
        raise DbHostNotAllowed(f"database host not allowed on this instance: {part.strip() or '(local socket)'}")
