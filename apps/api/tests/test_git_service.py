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


def test_with_credentials_injects_token_into_https():
    url = g._with_credentials("https://gitlab.com/g/r.git", "ghp_abc")
    assert url == "https://ghp_abc:x-oauth-basic@gitlab.com/g/r.git"


def test_with_credentials_replaces_existing_userinfo():
    url = g._with_credentials("https://old@gitlab.com/g/r.git", "tok")
    assert url == "https://tok:x-oauth-basic@gitlab.com/g/r.git"


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


def test_diff_payload_flags_binary_and_oversized():
    assert g._diff_payload("hello") == ("hello", False, False)
    # NUL byte in the head → treated as binary, content dropped.
    content, big, binary = g._diff_payload("ab\x00cd")
    assert binary is True and content == "" and big is False
    # Over the byte cap → too_large, content dropped (protects the UI).
    huge = "x" * (g._DIFF_MAX_BYTES + 1)
    content, big, binary = g._diff_payload(huge)
    assert big is True and content == "" and binary is False


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
