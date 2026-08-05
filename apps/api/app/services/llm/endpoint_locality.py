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
_INTERNAL_SUFFIXES = (
    ".local",
    ".localhost",
    ".internal",
    ".intranet",
    ".lan",
    ".home",
    ".corp",
    ".private",
    ".home.arpa",
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


def is_local_endpoint(url: str) -> bool:
    """True if `url` points at the local machine or a private network.

    Returns False for anything unrecognised — the safe default is "remote", which
    is the side that requires an explicit acknowledgement.
    """
    host = _host_of(url)
    if host is None:
        return False

    # IP literal: decide from the address itself. Note ipaddress rejects the
    # bracketed IPv6 form, which urlsplit has already stripped for us.
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return bool(
            ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_unspecified
        )

    if host == "localhost" or host.endswith(_INTERNAL_SUFFIXES):
        return True
    # A bare name with no dot cannot be a public FQDN (e.g. "ollama", "gpu-box") —
    # but only accept something that is actually a hostname. Free text ("not a
    # url") also parses as a dotless host, and must not reach the local path.
    return "." not in host and _HOSTNAME_RE.fullmatch(host) is not None
