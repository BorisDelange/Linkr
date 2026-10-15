"""Private catalogs are read server-side, through git, with the user's (user, host) token."""

import subprocess

import pytest

from app.services import catalog_remote_service as svc
from app.services import git_service


def _git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


@pytest.fixture
def catalog_remote(tmp_path) -> str:
    """A file:// remote whose `main` holds a catalog index (conftest allows local remotes)."""
    work = tmp_path / "work"
    work.mkdir()
    _git(work, "init", "-b", "main")
    (work / "catalog-index.json").write_text('{"schemaVersion":1}')
    _git(work, "add", ".")
    _git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "index")
    bare = tmp_path / "remote.git"
    subprocess.run(["git", "clone", "--bare", str(work), str(bare)], check=True, capture_output=True)
    return f"file://{bare}"


async def test_reads_the_file_at_the_branch_tip(catalog_remote):
    assert await svc.fetch_file(catalog_remote, "main", "catalog-index.json", "t") == b'{"schemaVersion":1}'


async def test_a_missing_index_file_is_not_found(catalog_remote):
    with pytest.raises(svc.CatalogFetchError) as exc:
        await svc.fetch_file(catalog_remote, "main", "catalog.json", "t")
    assert exc.value.kind == "not-found"


async def test_only_the_catalog_files_can_be_read(catalog_remote, monkeypatch):
    called = False

    async def spy(*_a, **_k):
        nonlocal called
        called = True

    monkeypatch.setattr(git_service, "read_remote_file", spy)
    with pytest.raises(svc.CatalogFetchError):
        await svc.fetch_file(catalog_remote, "main", "entries/secret.json", "t")
    assert not called


async def test_no_token_is_refused_before_any_git_call(monkeypatch):
    async def boom(*_a, **_k):
        raise AssertionError("git must not run without a token")

    monkeypatch.setattr(git_service, "read_remote_file", boom)
    with pytest.raises(svc.CatalogFetchError) as exc:
        await svc.fetch_file("https://gitlab.com/g/repo", "main", "catalog.json", None)
    assert exc.value.kind == "unauthorized"


@pytest.mark.parametrize(
    ("code", "kind"), [("auth_failed", "unauthorized"), ("not_found", "unauthorized"), ("network", "network")]
)
async def test_git_failures_map_to_catalog_errors(monkeypatch, code, kind):
    async def fail(*_a, **_k):
        raise git_service.GitError("x", code)

    monkeypatch.setattr(git_service, "read_remote_file", fail)
    with pytest.raises(svc.CatalogFetchError) as exc:
        await svc.fetch_file("https://gitlab.com/g/repo", "main", "catalog.json", "t")
    assert exc.value.kind == kind


async def test_internal_hosts_stay_blocked(monkeypatch):
    monkeypatch.setattr(git_service, "_LOCAL_REMOTES_ALLOWED", False)
    with pytest.raises(git_service.GitError):
        await git_service.read_remote_file("https://127.0.0.1/g/repo", "main", "catalog.json", "t", 100)
