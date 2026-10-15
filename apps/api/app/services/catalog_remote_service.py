"""Read a private catalog's index file on behalf of the acting user.

The browser reads a public catalog straight from the GitLab API, which sends CORS
headers. A private one needs the user's access token, and that token never leaves
the server — so the server reads the file with the (user, host) token git already
uses, and hands it back.
"""

from app.services import git_service

# Only the two files the catalog client reads: anything else would turn this route
# into a general authenticated read on the user's behalf.
CATALOG_FILES = frozenset({"catalog.json", "catalog-index.json"})
MAX_BYTES = 20 * 1024 * 1024


class CatalogFetchError(Exception):
    """`kind` matches the client's CatalogFetchError: network, not-found, unauthorized, malformed."""

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


async def fetch_file(repo_url: str, branch: str, file: str, token: str | None) -> bytes:
    if file not in CATALOG_FILES:
        raise CatalogFetchError("not-found")
    if not token:
        raise CatalogFetchError("unauthorized")
    try:
        content = await git_service.read_remote_file(repo_url, branch or "main", file, token, MAX_BYTES)
    except git_service.GitError as exc:
        # GitLab answers "not found", not "denied", for a private repo the token
        # cannot see — with a token sent, the two are the same refusal.
        raise CatalogFetchError(
            "unauthorized" if exc.code in ("auth_failed", "auth_required", "not_found") else "network"
        ) from exc
    if content is None:
        raise CatalogFetchError("not-found")
    return content
