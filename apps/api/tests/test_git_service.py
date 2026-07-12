"""git_service: credential handling must not leak tokens, and the
materialize→status→commit→diff cycle must report changes correctly."""

import io
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pytest

from app.services import git_service as g


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


def test_with_credentials_injects_token_as_oauth2_password():
    # oauth2:<token> — the form GitLab accepts for push (not <token>:x-oauth-basic).
    url = g._with_credentials("https://gitlab.com/g/r.git", "ghp_abc")
    assert url == "https://oauth2:ghp_abc@gitlab.com/g/r.git"


def test_with_credentials_replaces_existing_userinfo():
    url = g._with_credentials("https://old@gitlab.com/g/r.git", "tok")
    assert url == "https://oauth2:tok@gitlab.com/g/r.git"


def test_with_credentials_leaves_ssh_and_tokenless_urls_untouched():
    assert g._with_credentials("git@github.com:g/r.git", "tok") == "git@github.com:g/r.git"
    assert g._with_credentials("https://gitlab.com/g/r.git", None) == "https://gitlab.com/g/r.git"


def test_scrub_masks_token_in_error_text():
    assert g._scrub("fatal: auth failed for ghp_xyz", "ghp_xyz") == "fatal: auth failed for ***"


def test_unpack_rejects_zip_traversal():
    tree = Path(tempfile.mkdtemp())
    try:
        with pytest.raises(g.GitError):
            g._unpack_zip_into(_zip({"../escape.txt": "x"}), tree)
    finally:
        shutil.rmtree(tree, ignore_errors=True)


def test_safe_join_rejects_traversal_keeps_legit_paths():
    tree = Path(tempfile.mkdtemp())
    try:
        # A normal in-tree path resolves under the tree.
        assert g._safe_join(tree, "scripts/main.py").is_relative_to(tree.resolve())
        # Traversal (even deep) and absolute paths are refused.
        for bad in ("../../../../etc/passwd", "a/../../escape", "/etc/hostname"):
            with pytest.raises(g.GitError):
                g._safe_join(tree, bad)
    finally:
        shutil.rmtree(tree, ignore_errors=True)


@pytest.mark.asyncio
async def test_diff_rejects_traversing_path():
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        z = _zip({"project.json": "{}"})
        await g.commit_push(getter, "u", z, "main", "init", None, None)
        with pytest.raises(g.GitError):
            await g.diff(getter, "u", z, "main", "../../../../etc/passwd", None)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_reject_internal_host_blocks_ssrf_targets():
    # Metadata endpoint, loopback, and private ranges must be refused.
    for bad in (
        "http://169.254.169.254/latest/meta-data/",
        "https://127.0.0.1/x.git",
        "http://localhost:8000/x.git",
        "http://10.0.0.5/x.git",
        "https://192.168.1.1/x.git",
    ):
        with pytest.raises(g.GitError):
            g._reject_internal_host(bad)
    # ssh remotes are not our HTTP fetch to police; an unresolvable host is left
    # for git to error on (not blocked here).
    g._reject_internal_host("git@github.com:o/r.git")
    g._reject_internal_host("https://definitely-not-a-real-host.invalid/x.git")


@pytest.mark.asyncio
async def test_verify_remote_rejects_unreachable_url():
    # A bogus host must fail fast (non-interactive env → no credential-prompt hang).
    with pytest.raises(g.GitError):
        await g.verify_remote("https://example.invalid/nope/nope.git", None)


@pytest.mark.asyncio
async def test_verify_remote_detects_default_branch():
    tmp = Path(tempfile.mkdtemp())
    try:
        bare = tmp / "origin.git"
        subprocess.run(["git", "init", "--bare", "-b", "trunk", str(bare)], capture_output=True, check=True)
        wc = tmp / "wc"
        subprocess.run(["git", "clone", str(bare), str(wc)], capture_output=True, check=True)
        (wc / "f.txt").write_text("hi")
        subprocess.run(["git", "-C", str(wc), "add", "-A"], capture_output=True, check=True)
        subprocess.run(
            ["git", "-C", str(wc), "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-m", "x"],
            capture_output=True, check=True,
        )
        subprocess.run(["git", "-C", str(wc), "push", "origin", "trunk"], capture_output=True, check=True)
        r = await g.verify_remote(str(bare), None)
        assert r["ok"] is True and r["default"] == "trunk"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_clean_url_strips_web_navigation():
    # GitLab /-/ separator + query
    assert g._clean_url("https://framagit.org/interhop/linkr/test-project/-/tree/main?ref_type=heads") == (
        "https://framagit.org/interhop/linkr/test-project"
    )
    # GitLab subgroups preserved
    assert g._clean_url("https://framagit.org/a/b/c/repo/-/blob/main/f.py") == "https://framagit.org/a/b/c/repo"
    # GitHub nav segments
    assert g._clean_url("https://github.com/owner/repo/tree/main") == "https://github.com/owner/repo"
    assert g._clean_url("https://github.com/owner/repo/pull/42") == "https://github.com/owner/repo"
    # plain URL + query/fragment
    assert g._clean_url("https://github.com/owner/repo?tab=x#y") == "https://github.com/owner/repo"
    # a repo literally named like a nav segment (nothing after it) survives
    assert g._clean_url("https://github.com/owner/tree") == "https://github.com/owner/tree"
    # SSH untouched
    assert g._clean_url("git@github.com:owner/repo.git") == "git@github.com:owner/repo.git"


def test_classify_error_maps_git_stderr_to_codes():
    assert g._classify_error("remote: HTTP Basic: Access denied") == "auth_failed"
    assert g._classify_error("fatal: Authentication failed for 'https://x'") == "auth_failed"
    assert g._classify_error("fatal: repository 'x' not found") == "not_found"
    assert g._classify_error("fatal: could not resolve host: nope") == "network"
    assert g._classify_error("something odd") == "unknown"


def test_diff_payload_truncates_large_and_flags_binary():
    assert g._diff_payload("hello") == ("hello", False, False)
    # NUL byte in the head → treated as binary, content dropped (no preview).
    content, trunc, binary = g._diff_payload("ab\x00cd")
    assert binary is True and content == "" and trunc is False
    # Over the line cap → truncated to the first _DIFF_MAX_LINES, not dropped.
    many = "\n".join(str(i) for i in range(g._DIFF_MAX_LINES + 500))
    content, trunc, binary = g._diff_payload(many)
    assert trunc is True and binary is False
    assert content.count("\n") + 1 == g._DIFF_MAX_LINES  # preview capped
    assert content.startswith("0\n1\n")  # keeps the head


@pytest.mark.asyncio
async def test_status_commit_diff_cycle():
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        z1 = _zip({"project.json": '{"a":1}', "scripts/main.py": "print(1)"})
        st = await g.status(getter, "u", z1, "main", None)
        assert st["added"] == 2 and st["modified"] == 0 and st["deleted"] == 0

        r = await g.commit_push(getter, "u", z1, "main", "first", None, None)
        assert r["committed"] and not r["pushed"] and not r["nothingToCommit"]

        # Re-committing identical content is a no-op.
        r2 = await g.commit_push(getter, "u", z1, "main", "again", None, None)
        assert r2["nothingToCommit"]

        # Modify one file, delete the other.
        z2 = _zip({"project.json": '{"a":2}'})
        st2 = await g.status(getter, "u", z2, "main", None)
        assert st2["modified"] == 1 and st2["deleted"] == 1

        d = await g.diff(getter, "u", z2, "main", "project.json", None)
        assert d["changeType"] == "modified"
        assert d["oldContent"] == '{"a":1}' and d["newContent"] == '{"a":2}'

        br = await g.branches(getter, "u", None, None)
        assert br["current"] == "main" and "main" in br["branches"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
