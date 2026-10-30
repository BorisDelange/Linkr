"""Merge requests (GitLab) and pull requests (GitHub) on the forge a git remote
lives on, opened and read with the acting user's own token so the forge shows
them as the author.

Linkr does not re-implement review: it opens the request, then only reads its
state (open / merged / closed). Discussion and merging stay on the forge.
"""

from dataclasses import dataclass
from typing import Literal
from urllib.parse import quote, urlsplit

import httpx

from app.services import git_service

ForgeKind = Literal["gitlab", "github"]
ProposalState = Literal["open", "merged", "closed"]

_KNOWN_GITLAB_HOSTS = {"gitlab.com", "framagit.org"}
_TIMEOUT = httpx.Timeout(20.0)
# Tests swap in an httpx.MockTransport.
_transport: httpx.AsyncBaseTransport | None = None


class ForgeError(Exception):
    """`code`: unsupported (no known forge), auth_failed, not_found, network, rejected."""

    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Forge:
    kind: ForgeKind
    api_base: str
    # GitLab: "group/sub/repo". GitHub: "owner/repo".
    project_path: str


@dataclass(frozen=True)
class Proposal:
    number: int
    url: str
    state: ProposalState


def _https_form(remote_url: str) -> tuple[str, str, str]:
    """(scheme, host[:port], path) of a remote, ssh forms read as their https twin."""
    scp = git_service._SCP_LIKE.fullmatch(remote_url)
    if scp:
        host = scp.group(1)
        return "https", host, remote_url.split(":", 1)[1]
    parts = urlsplit(remote_url)
    if parts.scheme == "ssh":
        return "https", parts.hostname or "", parts.path
    return parts.scheme or "https", parts.netloc.rsplit("@", 1)[-1], parts.path


def _client(token: str | None, kind: ForgeKind | None = None) -> httpx.AsyncClient:
    headers = {"Accept": "application/json"}
    if token:
        if kind == "github":
            headers["Authorization"] = f"Bearer {token}"
        else:
            headers["PRIVATE-TOKEN"] = token
    return httpx.AsyncClient(headers=headers, timeout=_TIMEOUT, transport=_transport, follow_redirects=False)


async def detect(remote_url: str, token: str | None) -> Forge:
    scheme, netloc, path = _https_form(remote_url)
    path = path.strip("/").removesuffix(".git")
    host = netloc.split(":", 1)[0].lower()
    if host == "github.com":
        return Forge("github", "https://api.github.com", path)
    base = f"{scheme}://{netloc}"
    # Same SSRF rule as git itself: the forge API sits on the remote's host.
    git_service._reject_internal_host(base + "/")
    if host in _KNOWN_GITLAB_HOSTS:
        return Forge("gitlab", f"{base}/api/v4", path)
    try:
        async with _client(token) as client:
            r = await client.get(f"{base}/api/v4/version")
    except httpx.HTTPError as exc:
        raise ForgeError(f"could not reach {host}", "network") from exc
    if r.status_code in (200, 401, 403):
        return Forge("gitlab", f"{base}/api/v4", path)
    raise ForgeError(f"{host} is neither a GitLab nor GitHub", "unsupported")


def _raise_for(r: httpx.Response, what: str) -> None:
    if r.status_code in (401, 403):
        raise ForgeError(f"{what}: the token was refused ({r.status_code})", "auth_failed")
    if r.status_code == 404:
        raise ForgeError(f"{what}: not found", "not_found")
    if r.status_code >= 400:
        try:
            detail = r.json().get("message") or r.text
        except ValueError:
            detail = r.text
        raise ForgeError(f"{what}: {detail}", "rejected")


def _gitlab_state(raw: str) -> ProposalState:
    return "merged" if raw == "merged" else "closed" if raw in ("closed", "locked") else "open"


async def open_proposal(
    remote_url: str, token: str | None, *, source: str, target: str, title: str, description: str
) -> Proposal:
    forge = await detect(remote_url, token)
    try:
        async with _client(token, forge.kind) as client:
            if forge.kind == "gitlab":
                r = await client.post(
                    f"{forge.api_base}/projects/{quote(forge.project_path, safe='')}/merge_requests",
                    json={
                        "source_branch": source, "target_branch": target, "title": title,
                        "description": description, "remove_source_branch": True,
                    },
                )
                _raise_for(r, "open merge request")
                body = r.json()
                return Proposal(body["iid"], body["web_url"], _gitlab_state(body["state"]))
            r = await client.post(
                f"{forge.api_base}/repos/{forge.project_path}/pulls",
                json={"title": title, "head": source, "base": target, "body": description},
            )
            _raise_for(r, "open pull request")
            body = r.json()
            return Proposal(body["number"], body["html_url"], "open")
    except httpx.HTTPError as exc:
        raise ForgeError("could not reach the forge", "network") from exc


async def read_proposal(remote_url: str, token: str | None, number: int) -> Proposal:
    forge = await detect(remote_url, token)
    try:
        async with _client(token, forge.kind) as client:
            if forge.kind == "gitlab":
                r = await client.get(
                    f"{forge.api_base}/projects/{quote(forge.project_path, safe='')}/merge_requests/{number}"
                )
                _raise_for(r, "read merge request")
                body = r.json()
                return Proposal(body["iid"], body["web_url"], _gitlab_state(body["state"]))
            r = await client.get(f"{forge.api_base}/repos/{forge.project_path}/pulls/{number}")
            _raise_for(r, "read pull request")
            body = r.json()
            state: ProposalState = "merged" if body.get("merged_at") else "open" if body["state"] == "open" else "closed"
            return Proposal(body["number"], body["html_url"], state)
    except httpx.HTTPError as exc:
        raise ForgeError("could not reach the forge", "network") from exc
