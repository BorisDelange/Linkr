"""The forge client against recorded GitLab / GitHub answers (no network)."""

import json

import httpx
import pytest

from app.services import forge_service as f
from app.services import git_service


@pytest.fixture
def calls(monkeypatch):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path = request.url.path
        if path.endswith("/api/v4/version"):
            return httpx.Response(200, json={"version": "18.5"})
        if path.endswith("/merge_requests") and request.method == "POST":
            return httpx.Response(201, json={"iid": 7, "web_url": "http://forge/sandbox/ws/-/merge_requests/7", "state": "opened"})
        if path.endswith("/merge_requests/7"):
            return httpx.Response(200, json={"iid": 7, "web_url": "http://forge/sandbox/ws/-/merge_requests/7", "state": "merged"})
        if path.endswith("/pulls") and request.method == "POST":
            return httpx.Response(201, json={"number": 3, "html_url": "https://github.com/o/r/pull/3", "state": "open"})
        if path.endswith("/pulls/3"):
            return httpx.Response(200, json={"number": 3, "html_url": "https://github.com/o/r/pull/3", "state": "closed", "merged_at": None})
        return httpx.Response(404, json={"message": "404 Not found"})

    monkeypatch.setattr(f, "_transport", httpx.MockTransport(handler))
    monkeypatch.setattr(git_service, "_LOCAL_REMOTES_ALLOWED", False)
    monkeypatch.setattr(git_service.settings, "git_allowed_hosts", "localhost:8929")
    return seen


async def test_gitlab_merge_request_is_opened_with_the_users_token_then_read(calls):
    p = await f.open_proposal(
        "http://localhost:8929/sandbox/ws.git", "glpat-alice",
        source="linkr/alice/1", target="main", title="Wiki: setup", description="d",
    )
    assert p == f.Proposal(7, "http://forge/sandbox/ws/-/merge_requests/7", "open")
    post = calls[-1]
    assert post.url.raw_path == b"/api/v4/projects/sandbox%2Fws/merge_requests"
    assert post.headers["PRIVATE-TOKEN"] == "glpat-alice"
    assert json.loads(post.content)["source_branch"] == "linkr/alice/1"

    p = await f.read_proposal("http://localhost:8929/sandbox/ws.git", "glpat-alice", 7)
    assert p.state == "merged"


async def test_github_pull_request_and_its_closed_state(calls):
    p = await f.open_proposal(
        "git@github.com:o/r.git", "ghp_x", source="linkr/a/1", target="main", title="t", description="d",
    )
    assert p.number == 3 and calls[-1].headers["Authorization"] == "Bearer ghp_x"
    assert (await f.read_proposal("https://github.com/o/r", "ghp_x", 3)).state == "closed"


async def test_a_private_host_not_listed_is_refused(calls, monkeypatch):
    monkeypatch.setattr(git_service.settings, "git_allowed_hosts", "")
    with pytest.raises(git_service.GitError):
        await f.detect("http://localhost:8929/sandbox/ws.git", "t")
