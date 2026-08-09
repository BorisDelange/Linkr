"""Is an LLM endpoint local to the institution?

This decides whether prompts — which may carry clinical context — can leave the
deployment. It is therefore computed server-side from the URL and never taken
from the client: a user must not be able to tick "local" on api.openai.com.

"Local" means the host resolves, by its literal form, to the machine or the
private network: loopback, an RFC1918/RFC4193 private address, a link-local
address, or a bare hostname with no public TLD (``ollama``, ``gpu-box.internal``).
Anything else — including a public IP and any hostname with a public-looking
suffix — is remote.

Deliberately conservative: we do NOT resolve DNS. A name that resolves to a
private IP today may resolve elsewhere tomorrow, and a DNS lookup at write time
would make the stored verdict a snapshot of something mutable. Unknown or
unparseable input is treated as remote, so a malformed URL can never silently
grant the permissive path.
"""

import ipaddress
import re
from urllib.parse import urlsplit

# A single DNS label (RFC 1123): alphanumeric plus inner hyphens.
_HOSTNAME_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?")

# Suffixes reserved for private/internal naming (RFC 6762, RFC 8375, common use).
# A bare hostname with no dot is also internal by construction.
#
# `.internal` is deliberately EXCLUDED: `metadata.google.internal` is the GCP
# instance-metadata host, so admitting the suffix would put cloud credential
# theft on the ack-free "local" side.
_INTERNAL_SUFFIXES = (
    ".local",
    ".localhost",
    ".intranet",
    ".lan",
    ".home",
    ".corp",
    ".private",
    ".home.arpa",
)

# Cloud instance-metadata endpoints. These are technically link-local, but they
# are the highest-value SSRF target (IAM credential theft), so they are never
# "local" for the acknowledgement decision and are always blocked at proxy time.
_METADATA_HOSTS = frozenset(
    {
        "169.254.169.254",  # AWS / Azure / GCP / OpenStack IMDS
        "fd00:ec2::254",  # AWS IMDS over IPv6
        "100.100.100.200",  # Alibaba Cloud
    }
)


def _host_of(url: str) -> str | None:
    """The bare hostname of `url`, lowercased, or None if unusable."""
    candidate = (url or "").strip()
    if not candidate:
        return None
    # urlsplit only populates .hostname when a scheme is present; tolerate
    # "localhost:11434" so a user pasting a bare host:port isn't misjudged.
    if "//" not in candidate:
        candidate = f"//{candidate}"
    try:
        host = urlsplit(candidate).hostname
    except ValueError:
        return None
    return host.lower() if host else None


def _ip_of(host: str) -> ipaddress._BaseAddress | None:
    """The host as an IP literal, or None if it is a name.

    Rejects the dotless-decimal / hex forms (`2130706433`, `0x7f000001`) that
    most HTTP stacks would still resolve to 127.0.0.1 — `ipaddress` does not
    parse them, so without this they would fall through to the hostname branch
    and be judged by shape rather than by address.
    """
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def is_local_endpoint(url: str) -> bool:
    """True if `url` points at the local machine or a private network AND is safe
    to reach without an egress acknowledgement.

    Returns False for anything unrecognised — the safe default is "remote", which
    is the side that requires an explicit acknowledgement. Cloud metadata,
    link-local and the unspecified address are NOT local here: they are internal
    targets a user should never be pointing an LLM at, and treating them as local
    would grant them the ack-free path (see `is_blocked_endpoint`).
    """
    host = _host_of(url)
    if host is None:
        return False
    # Never grant the ack-free path to an SSRF target, even though some of them
    # (link-local, 0.0.0.0) technically classify as private.
    if is_blocked_endpoint(url):
        return False

    # IP literal: decide from the address itself. Note ipaddress rejects the
    # bracketed IPv6 form, which urlsplit has already stripped for us.
    ip = _ip_of(host)
    if ip is not None:
        return bool(ip.is_loopback or ip.is_private)

    if host == "localhost" or host.endswith(_INTERNAL_SUFFIXES):
        return True
    # A bare name with no dot cannot be a public FQDN (e.g. "ollama", "gpu-box") —
    # but only accept something that is actually a hostname. Free text ("not a
    # url"), and dotless all-digit / hex strings, must not reach the local path.
    if "." in host or _HOSTNAME_RE.fullmatch(host) is None:
        return False
    return not host.isdigit() and not host.startswith("0x")


def is_blocked_endpoint(url: str) -> bool:
    """True if `url` must never be forwarded to, regardless of acknowledgement.

    This is the SSRF gate, checked at PROXY time (not just at write time): the
    stored `is_local` verdict is not enough on its own, because a provider's URL
    can be edited and because "local" is deliberately permissive for the private
    network. Cloud metadata, the unspecified address (`0.0.0.0`/`::`), and
    link-local are always refused; a name we cannot parse as an IP is left to the
    scheme/allowlist checks upstream.
    """
    host = _host_of(url)
    if host is None:
        return True
    if host in _METADATA_HOSTS:
        return True
    ip = _ip_of(host)
    if ip is not None:
        # Danger space first: link-local (169.254/16 — carries IMDS — is ALSO
        # is_private in Python, so it must be tested before the allow), plus the
        # unspecified/multicast addresses that are never a real endpoint.
        if ip.is_link_local or ip.is_unspecified or ip.is_multicast:
            return True
        # Loopback and RFC1918/RFC4193 private are legitimate local targets.
        # `::1` is both loopback and is_reserved, so this allow must precede the
        # reserved check.
        if ip.is_loopback or ip.is_private:
            return False
        return bool(ip.is_reserved)
    return host.endswith(".internal")
