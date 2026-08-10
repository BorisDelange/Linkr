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


def _bare_remote(tmp: Path) -> str:
    """Create a bare git repo on disk to act as `origin`, returning its path (a
    local filesystem URL — _reject_internal_host only guards http(s), so it passes
    through, letting sync_state fetch a real remote branch without network)."""
    remote = tmp / "remote.git"
    subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True, env=g._git_env())
    return str(remote)


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


def test_set_sync_state_schema_validates_oid():
    import pydantic

    from app.schemas.git import GitSetSyncStateRequest

    # A real oid is accepted; an option-injection payload is rejected at the API
    # boundary so it can never reach `git fetch` argv.
    GitSetSyncStateRequest(branch="main", syncedOid="a1b2c3d4e5f6")
    for bad in ("--upload-pack=touch /tmp/x", "-x", "HEAD", "not hex", ""):
        with pytest.raises(pydantic.ValidationError):
            GitSetSyncStateRequest(branch="main", syncedOid=bad)


def test_safe_ref_rejects_option_injection():
    # Legit branch names pass through unchanged.
    for ok in ("main", "release/1.2", "feature-x", "v2.0.1", "dev_branch"):
        assert g._safe_ref(ok) == ok
    # A leading dash (option injection like --upload-pack=<cmd>) and shell/space
    # metacharacters are refused — these reach git argv with no `--` separator.
    for bad in (
        "--upload-pack=touch /tmp/pwned",
        "-x",
        "main; rm -rf /",
        "main branch",
        "",
        "..",
    ):
        with pytest.raises(g.GitError):
            g._safe_ref(bad)


def test_safe_oid_rejects_option_injection():
    # A real (abbreviated) oid passes; a dash-leading or non-hex value is refused.
    assert g._safe_oid("a1b2c3d") == "a1b2c3d"
    assert g._safe_oid("0" * 40) == "0" * 40
    for bad in ("--upload-pack=touch /tmp/x", "-x", "HEAD", "ab", "g" * 40, ""):
        with pytest.raises(g.GitError):
            g._safe_oid(bad)


@pytest.mark.asyncio
async def test_sync_state_rejects_malicious_branch_and_oid():
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        # A malicious branch or synced_oid must be rejected before any git call,
        # even with a remote_url present (would otherwise reach `git fetch` argv).
        with pytest.raises(g.GitError):
            await g.sync_state(getter, "u", "--upload-pack=x", "https://example.invalid/r.git", None)
        with pytest.raises(g.GitError):
            await g.sync_state(getter, "u", "main", "https://example.invalid/r.git", "--upload-pack=x")
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


def test_condense_hunks_shows_change_past_line_cap():
    # A single edit far below the line cap must still be visible (the whole point:
    # positional head-truncation would have hidden it).
    n = g._DIFF_MAX_LINES + 500
    old = "\n".join(f"row{i}" for i in range(n))
    edit_line = g._DIFF_MAX_LINES + 200
    new = "\n".join("CHANGED" if i == edit_line else f"row{i}" for i in range(n))

    old_c, new_c, trunc = g._condense_hunks(old, new)
    assert trunc is False
    assert "CHANGED" in new_c and f"row{edit_line}" in old_c
    # Condensed, not the whole file: far smaller than the input, head not included.
    assert new_c.count("\n") + 1 < g._DIFF_MAX_LINES
    assert "row0" not in old_c
    # Both sides carry the same "@@" markers so Monaco aligns them as context.
    assert old_c.count("@@") == new_c.count("@@") >= 1
    # Context lines around the edit are present on both sides.
    assert f"row{edit_line - 1}" in new_c and f"row{edit_line + 1}" in new_c


def test_condense_hunks_caps_number_of_hunks():
    # More separated changes than the hunk cap → truncated=True and bounded output.
    step = 2 * g._DIFF_HUNK_CONTEXT + 4  # spacing so hunks never merge
    count = g._DIFF_MAX_HUNKS + 50
    n = count * step
    old = "\n".join(f"row{i}" for i in range(n))
    changed = {k * step for k in range(count)}
    new = "\n".join("X" if i in changed else f"row{i}" for i in range(n))

    old_c, new_c, trunc = g._condense_hunks(old, new)
    assert trunc is True
    markers = sum(1 for line in old_c.split("\n") if line.startswith("@@"))
    assert markers == g._DIFF_MAX_HUNKS


def test_condense_hunks_identical_is_empty():
    same = "\n".join(f"row{i}" for i in range(2000))
    old_c, new_c, trunc = g._condense_hunks(same, same)
    assert old_c == "" and new_c == "" and trunc is False


def test_normalize_eol_collapses_crlf_and_cr():
    assert g._normalize_eol("a\r\nb\rc\nd") == "a\nb\nc\nd"
    # A file that only changed line-ending style becomes byte-identical.
    body = "\n".join(f"row{i}" for i in range(10))
    assert g._normalize_eol(body.replace("\n", "\r\n")) == body


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
        assert d["truncationMode"] == "none"

        br = await g.branches(getter, "u", None, None)
        assert br["current"] == "main" and "main" in br["branches"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_commit_push_selecting_only_a_deletion_removes_it_from_head():
    """Ticking ONLY a deleted file (a path present in HEAD but absent from the new
    export) must stage and commit that deletion, so it disappears from the pushed
    tree. Regression guard: the deletion is selected on its own, with every other
    change left unchecked."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    def head_tree(remote: str) -> set[str]:
        out = subprocess.run(
            ["git", "ls-tree", "-r", "--name-only", "main"],
            cwd=remote, capture_output=True, text=True, check=True, env=g._git_env(),
        )
        return set(out.stdout.split())

    try:
        remote = _bare_remote(tmp)
        z1 = _zip({"project.json": '{"a":1}', "datasets/foo/_data.json": '{"rows":[]}'})
        await g.commit_push(getter, "u", z1, "main", "init", remote, None)
        assert "datasets/foo/_data.json" in head_tree(remote)

        # New export drops the data file (e.g. a re-export with includeData off) AND
        # modifies project.json. The user ticks ONLY the deletion.
        z2 = _zip({"project.json": '{"a":2}'})
        r = await g.commit_push(
            getter, "u", z2, "main", "drop data", remote, None,
            paths=["datasets/foo/_data.json"],
        )
        assert r["committed"] and r["pushed"]

        tree = head_tree(remote)
        assert "datasets/foo/_data.json" not in tree  # the deletion landed
        assert tree == {"project.json"}  # unticked modification stayed at its old content
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_deletion_of_path_with_spaces_is_reported_unquoted_and_removable():
    """A tracked path containing spaces (`datasets/table agregee vf/_data.json`)
    must be reported by status WITHOUT git's double-quote wrapping, so the exact
    string round-trips back through commit_push and the deletion actually stages.
    Regression: plain `--porcelain` quotes such paths, and the quotes leaked into
    `git rm`, which then silently no-op'd (the file was never removed)."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    def head_tree(remote: str) -> set[str]:
        out = subprocess.run(
            ["git", "ls-tree", "-r", "--name-only", "main"],
            cwd=remote, capture_output=True, text=True, check=True, env=g._git_env(),
        )
        return set(out.stdout.splitlines())  # names may contain spaces → split on lines

    spaced = "datasets/table agregee vf/_data.json"
    try:
        remote = _bare_remote(tmp)
        await g.commit_push(getter, "u", _zip({"project.json": "{}", spaced: "x"}), "main", "init", remote, None)
        assert spaced in head_tree(remote)

        # Re-export drops the spaced dataset folder. Status must surface the exact
        # unquoted path, which the client sends back as the selected deletion.
        z2 = _zip({"project.json": "{}"})
        st = await g.status(getter, "u", z2, "main", None)
        deleted = [f["path"] for f in st["files"] if f["changeType"] == "deleted"]
        assert deleted == [spaced]  # unquoted, byte-exact

        r = await g.commit_push(getter, "u", z2, "main", "drop spaced", remote, None, paths=deleted)
        assert r["committed"] and r["pushed"]
        assert spaced not in head_tree(remote)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_diff_content_flags_eol_only_vs_no_content_change():
    """The empty-diff wording depends on WHY git flags a file modified: identical
    bytes → no_content_change (a storage-mode switch, e.g. text→LFS); identical only
    after normalizing line endings → eol_only. This is the pure decision the diff()
    early-return encodes; the full flow is covered by the integration tests below.
    (In a repo with core.autocrlf, git normalizes CRLF on `add`, so eol_only rarely
    survives to diff() — no_content_change catches it — hence a unit-level check.)"""
    lf = "line 0\nline 1\nline 2"
    crlf = lf.replace("\n", "\r\n")

    # Byte-identical → not an EOL change.
    assert (lf == lf) and g._normalize_eol(lf) == g._normalize_eol(lf)
    # Differ raw, equal once normalized → an EOL-only change.
    assert lf != crlf and g._normalize_eol(lf) == g._normalize_eol(crlf)


@pytest.mark.asyncio
async def test_diff_reports_eol_only_change():
    """A file whose only difference is line-ending style is flagged modified by git
    but must diff as an empty content notice — not an empty hunk view. Depending on
    the repo's autocrlf setting git may normalize on `add`, so the result is one of
    the two 'no real change' modes."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        body = "\n".join(f"line {i}" for i in range(50))
        await g.commit_push(getter, "u", _zip({"data.csv": body}), "main", "lf", None, None)

        crlf = _zip({"data.csv": body.replace("\n", "\r\n")})
        d = await g.diff(getter, "u", crlf, "main", "data.csv", None)
        assert d["truncationMode"] in ("eol_only", "no_content_change")
        assert d["oldContent"] == "" and d["newContent"] == ""
        assert d["binary"] is False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_diff_reports_no_content_change_for_byte_identical_content():
    """Byte-identical content (same line endings too) must diff as no_content_change
    — the case a text→LFS storage-mode switch produces, where git flags the file
    modified but nothing about the content actually changed."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        body = "\n".join(f"line {i}" for i in range(50))
        await g.commit_push(getter, "u", _zip({"data.csv": body}), "main", "init", None, None)

        d = await g.diff(getter, "u", _zip({"data.csv": body}), "main", "data.csv", None)
        assert d["truncationMode"] == "no_content_change"
        assert d["oldContent"] == "" and d["newContent"] == ""
        assert d["binary"] is False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_sync_state_no_remote_branch_is_neutral():
    """No remote branch (never pushed) → nothing upstream, so not behind/diverged."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        remote = _bare_remote(tmp)  # bare but empty: branch 'main' doesn't exist yet
        s = await g.sync_state(getter, "u", "main", remote, None)
        assert s["remoteHead"] is None
        assert s["behind"] is False and s["diverged"] is False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_sync_state_unanchored_and_in_sync_adopts_head_reporting_nothing_to_pull():
    """An unanchored entity sitting on the remote head adopts it as the baseline.

    Nothing is behind or diverged (there is nothing to pull), but the anchor is
    reported via adoptedOid so the route can persist it — without a baseline the
    NEXT remote push could never be detected."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        remote = _bare_remote(tmp)
        pushed = await g.commit_push(getter, "u", _zip({"project.json": '{"a":1}'}), "main", "init", remote, None)
        head = pushed["commit"]["oid"]

        s = await g.sync_state(getter, "u", "main", remote, None)  # synced_oid=None
        assert s["remoteHead"] == head
        assert s["behind"] is False and s["diverged"] is False
        assert s["adoptedOid"] == head
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_sync_state_unanchored_behind_adopts_local_head_and_reports_behind():
    """The gap this closes: an entity linked before its scope had set-sync-state has
    no DB anchor, so it reported "in sync" no matter how far the remote moved — the
    Pull button never appeared. The local HEAD IS the missing baseline, so it is
    adopted when it is an ancestor of the remote head."""
    tmp = Path(tempfile.mkdtemp())
    local, other = tmp / "repo", tmp / "other"

    try:
        remote = _bare_remote(tmp)
        # This entity pushes v1, then FORGETS its anchor (the pre-fix state).
        first = await g.commit_push(lambda _u: local, "u", _zip({"project.json": '{"a":1}'}), "main", "v1", remote, None)
        v1 = first["commit"]["oid"]
        # Someone else advances the remote to v2 — the "modification on the git
        # remote" case that must be detected.
        second = await g.commit_push(lambda _u: other, "o", _zip({"project.json": '{"a":2}'}), "main", "v2", remote, None)
        v2 = second["commit"]["oid"]
        assert v1 != v2

        s = await g.sync_state(lambda _u: local, "u", "main", remote, None)
        assert s["remoteHead"] == v2
        assert s["adoptedOid"] == v1, "local HEAD should become the baseline"
        assert s["behind"] is True and s["diverged"] is False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_sync_state_unanchored_with_no_local_commit_stays_neutral():
    """A fresh working tree with no commit of its own has no baseline to adopt, so
    nothing is claimed — adopting the remote head here would assert we already hold
    content we have never had."""
    tmp = Path(tempfile.mkdtemp())
    local, other = tmp / "repo", tmp / "other"

    try:
        remote = _bare_remote(tmp)
        await g.commit_push(lambda _u: other, "o", _zip({"project.json": '{"a":1}'}), "main", "v1", remote, None)

        s = await g.sync_state(lambda _u: local, "u", "main", remote, None)
        assert s["adoptedOid"] is None
        assert s["behind"] is False and s["diverged"] is False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_sync_state_reports_behind_when_remote_advanced():
    """Anchored at an old commit, the remote moved on → behind (the anchor is an
    ancestor of the remote head). Anchored at the head → in sync."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        remote = _bare_remote(tmp)
        first = await g.commit_push(getter, "u", _zip({"project.json": '{"a":1}'}), "main", "v1", remote, None)
        old_oid = first["commit"]["oid"]
        second = await g.commit_push(getter, "u", _zip({"project.json": '{"a":2}'}), "main", "v2", remote, None)
        new_oid = second["commit"]["oid"]
        assert old_oid != new_oid

        # Anchored at v1, remote head is v2 (v1 is an ancestor) → behind.
        s = await g.sync_state(getter, "u", "main", remote, old_oid)
        assert s["remoteHead"] == new_oid
        assert s["behind"] is True and s["diverged"] is False

        # Anchored at the current head → in sync, not behind.
        s2 = await g.sync_state(getter, "u", "main", remote, new_oid)
        assert s2["behind"] is False and s2["diverged"] is False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_pull_preview_returns_base_and_remote_content():
    """pull_preview returns the managed JSON files at BASE (synced_oid) and REMOTE
    (head), plus stats for heavy families — the raw material for the client 3-way."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        remote = _bare_remote(tmp)
        base_csv = "code,name\nA,alpha\nB,beta\n"  # 2 data rows
        first = await g.commit_push(
            getter, "u",
            _zip({"mappings.json": '[{"a":1}]', "project.json": '{"name":"v1"}', "source-concepts.csv": base_csv}),
            "main", "v1", remote, None,
        )
        base_oid = first["commit"]["oid"]
        await g.commit_push(
            getter, "u",
            _zip({"mappings.json": '[{"a":2}]', "project.json": '{"name":"v2"}', "source-concepts.csv": base_csv + "C,gamma\n"}),
            "main", "v2", remote, None,
        )

        pv = await g.pull_preview(getter, "u", "main", remote, base_oid)
        assert pv["base"]["files"]["mappings.json"] == '[{"a":1}]'
        assert pv["remote"]["files"]["mappings.json"] == '[{"a":2}]'
        assert pv["base"]["files"]["project.json"] == '{"name":"v1"}'
        assert pv["remote"]["files"]["project.json"] == '{"name":"v2"}'
        # CSV stats (row count excludes the header).
        assert pv["base"]["stats"]["source-concepts.csv"]["rowCount"] == 2
        assert pv["remote"]["stats"]["source-concepts.csv"]["rowCount"] == 3
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_commit_push_refuses_when_behind_the_anchor():
    """Pushing while the remote moved past our anchor would fast-forward over the
    un-pulled remote work and drop it → must raise pull_required. Passing the
    up-to-date anchor (or none) allows the push."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        remote = _bare_remote(tmp)
        first = await g.commit_push(getter, "u", _zip({"project.json": '{"a":1}'}), "main", "v1", remote, None)
        old_oid = first["commit"]["oid"]
        # Simulate someone else pushing v2 from another clone.
        tmp2 = Path(tempfile.mkdtemp())
        try:
            def getter2(_uid):
                return tmp2 / "repo"
            await g.commit_push(getter2, "u", _zip({"project.json": '{"a":2}'}), "main", "v2", remote, None)
        finally:
            shutil.rmtree(tmp2, ignore_errors=True)

        # Our anchor is still v1 → the remote is ahead → push must be refused.
        with pytest.raises(g.GitError) as exc:
            await g.commit_push(getter, "u", _zip({"project.json": '{"a":3}'}), "main", "v3", remote, None, None, old_oid)
        assert exc.value.code == "pull_required"

        # No anchor passed → first-push semantics, allowed (won't refuse).
        r = await g.commit_push(getter, "u", _zip({"project.json": '{"a":3}'}), "main", "v3", remote, None, None, None)
        assert r["committed"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_pull_file_bytes_returns_remote_content():
    """pull_file_bytes returns a managed file's bytes at the remote head — the raw
    content the pull needs when taking the remote version of a whole-list family."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        remote = _bare_remote(tmp)
        csv = "code,name\nA,alpha\nB,beta\n"
        await g.commit_push(getter, "u", _zip({"source-concepts.csv": csv, "mappings.json": "[]"}), "main", "v1", remote, None)
        # Advance so the working tree isn't already the head (forces a real checkout).
        await g.commit_push(getter, "u", _zip({"source-concepts.csv": csv + "C,gamma\n", "mappings.json": "[]"}), "main", "v2", remote, None)

        data = await g.pull_file_bytes(getter, "u", "main", "source-concepts.csv", remote)
        assert data.decode("utf-8") == csv + "C,gamma\n"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_clone_to_zip_returns_head_oid():
    """clone_to_zip must return the cloned HEAD so the import can anchor the new
    entity's sync state to it (else 'behind' can never be detected for an imported
    copy that was never pushed from)."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        remote = _bare_remote(tmp)
        pushed = await g.commit_push(getter, "u", _zip({"project.json": '{"a":1}'}), "main", "seed", remote, None)
        head = pushed["commit"]["oid"]

        data, oid = await g.clone_to_zip(remote, "main", None)
        assert oid == head
        # The ZIP carries the tree without .git.
        names = zipfile.ZipFile(io.BytesIO(data)).namelist()
        assert "project.json" in names and not any(n.startswith(".git/") for n in names)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_pull_preview_ships_readme_and_license_per_language():
    """README/LICENSE reach the preview so a mapping-project pull can merge them.

    They are not tree content — the entity owns them as readme/license fields — and
    they were absent from the managed-file list, so a remote commit that added a
    README reported nothing to pull. Enumerated from the commit rather than
    hardcoded, because the README has one file per language."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        remote = _bare_remote(tmp)
        await g.commit_push(getter, "u", _zip({
            "project.json": '{"name":{"en":"P"},"license":{"id":"mit"}}',
            "mappings.json": "[]",
            "README.md": "# English",
            "README.fr.md": "# Francais",
            "LICENSE.md": "MIT text",
        }), "main", "docs", remote, None)

        preview = await g.pull_preview(getter, "u", "main", remote, None)
        files = preview["remote"]["files"]
        assert files["README.md"] == "# English"
        assert files["README.fr.md"] == "# Francais"
        assert files["LICENSE.md"] == "MIT text"
        # The pre-existing managed files still come through.
        assert files["mappings.json"] == "[]"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_docs_regex_matches_readme_variants_only():
    """The enumeration must catch every language sibling and nothing else — a
    stray match would ship unrelated files to the client as 'docs'."""
    for ok in ("README.md", "readme.md", "README.fr.md", "README.EN.md", "LICENSE.md", "license.md"):
        assert g._DOCS_RE.match(ok), ok
    for bad in ("README", "READMEX.md", "docs/README.md", "LICENSE.txt", "README.french.md"):
        assert not g._DOCS_RE.match(bad), bad
