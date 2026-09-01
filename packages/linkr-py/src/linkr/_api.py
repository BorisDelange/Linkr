"""Talking to the Linkr server from inside a kernel.

Uses urllib rather than requests/httpx: this must work in an empty, unbuilt
project environment, where the only packages available are this library's own
dependencies.
"""

import json
import os
import urllib.error
import urllib.request


class LinkrError(RuntimeError):
    """Something the script author can act on: no session, expired token, or an
    unknown database."""


def api_call(path: str) -> list[dict]:
    base = os.environ.get("LINKR_API_URL", "")
    token = os.environ.get("LINKR_TOKEN", "")
    project = os.environ.get("LINKR_PROJECT_UID", "")
    if not (base and token and project):
        raise LinkrError(
            "Cannot reach the Linkr server: LINKR_API_URL, LINKR_TOKEN and "
            "LINKR_PROJECT_UID are only set inside a Linkr IDE session (console, "
            "terminal or job). The path helpers work anywhere, but databases do not."
        )
    url = f"{base.rstrip('/')}/api/v1/projects/{project}/client{path}"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise LinkrError(
                f"The Linkr server refused this request (HTTP {e.code}). Your "
                "session token may have expired — restart the console or terminal."
            ) from e
        raise LinkrError(f"The Linkr server returned HTTP {e.code}.") from e
    except urllib.error.URLError as e:
        raise LinkrError(f"Could not reach the Linkr server at {base}: {e.reason}") from e


def find_database(rows: list[dict], alias: str) -> dict:
    """Resolve a database by its alias, and only by its alias.

    Not the display name: renaming a database would silently break every script
    addressing it, and a name can be localized, so there is no single "the" name.
    Not the uuid either: it is stable but unreadable in code someone has to review.
    The alias is the same slug the SQL editor uses (``ds_<alias>``).

    Nothing enforces alias uniqueness today (no DB constraint, no server check), so
    a duplicate is reported rather than silently resolved to whichever row came
    first — picking one at random is how a script quietly reads the wrong database.
    """
    matches = [row for row in rows if row.get("alias") == alias]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        ids = ", ".join(str(m.get("id")) for m in matches)
        raise LinkrError(
            f"Several databases share the alias {alias!r} ({ids}). Rename one in the "
            "Databases page so a script can address them unambiguously."
        )
    available = ", ".join(str(r.get("alias")) for r in rows) or "(none)"
    raise LinkrError(
        f"No database with alias {alias!r} in this project. Available: {available}"
    )
