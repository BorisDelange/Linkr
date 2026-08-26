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


def test_condense_hunks_caps_number_of_hunks(monkeypatch):
    # More separated changes than the hunk cap → truncated=True and bounded output.
    # Lower the cap rather than generating a file big enough to reach the real one:
    # that many scattered changes now trips the core-size guard first (and would
    # take minutes in difflib, which is exactly why the guard exists).
    monkeypatch.setattr(g, "_DIFF_MAX_HUNKS", 20)
    step = 2 * g._DIFF_HUNK_CONTEXT + 4  # spacing so hunks never merge
    count = g._DIFF_MAX_HUNKS + 5
    n = count * step
    old = "\n".join(f"row{i}" for i in range(n))
    changed = {k * step for k in range(count)}
    new = "\n".join("X" if i in changed else f"row{i}" for i in range(n))

    old_c, new_c, trunc = g._condense_hunks(old, new)
    assert trunc is True
    markers = sum(1 for line in old_c.split("\n") if line.startswith("@@"))
    assert markers == g._DIFF_MAX_HUNKS


def test_condense_hunks_gives_up_when_changes_are_scattered_through_a_big_file():
    # The real mappings.json case: ~1500 JSON objects, one changed line in each.
    # The affix trim can't help (the changes reach both ends), so difflib would
    # run for minutes — measured quadratic: 1.7s at 2k lines, 110s at 8k. None
    # means "undiffable", and the route turns that into a download offer.
    n = g._DIFF_HUNK_MAX_CORE_LINES + 500
    old = "\n".join(f'  "id": 0,  // row{i}' for i in range(n))
    new = "\n".join(f'  "id": {2_000_000 + i},  // row{i}' for i in range(n))
    assert g._condense_hunks(old, new) is None


def test_condense_hunks_still_diffs_a_huge_file_with_clustered_changes():
    # The guard measures the core LEFT AFTER trimming, not raw size: a generated
    # file where only a few adjacent lines changed must still get a real diff.
    n = 60_000
    lines = [f"row{i}" for i in range(n)]
    old = "\n".join(lines)
    changed = list(lines)
    changed[30_000] = "CHANGED"
    new = "\n".join(changed)

    condensed = g._condense_hunks(old, new)
    assert condensed is not None
    old_c, new_c, trunc = condensed
    assert "CHANGED" in new_c and "CHANGED" not in old_c
    assert trunc is False


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
async def test_diff_full_returns_both_sides_verbatim_past_every_size_guard():
    """`full=True` is for callers that PARSE the payload (the mappings review
    table keys JSON objects by mapping key). A head preview or a condensed hunk
    view is not valid JSON, so the guards must not apply — and in server mode this
    is the ONLY way the client can read the local side, since it builds no export
    ZIP of its own."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        # Comfortably past _DIFF_MAX_LINES so the normal path would truncate.
        old_body = "\n".join(f'{{"i": {i}}}' for i in range(g._DIFF_MAX_LINES + 500))
        new_body = old_body.replace('"i": 0', '"i": 999')
        await g.commit_push(getter, "u", _zip({"mappings.json": old_body}), "main", "init", None, None)

        # The normal path condenses this to its changed blocks — readable, but not
        # parseable JSON, which is exactly why `full` exists.
        normal = await g.diff(getter, "u", _zip({"mappings.json": new_body}), "main", "mappings.json", None)
        assert normal["truncationMode"] == "hunks"
        assert normal["newContent"] != new_body

        full = await g.diff(
            getter, "u", _zip({"mappings.json": new_body}), "main", "mappings.json", None, None, True
        )
        assert full["truncated"] is False
        assert full["truncationMode"] == "none"
        assert full["oldContent"] == old_body
        assert full["newContent"] == new_body
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
async def test_sync_state_never_adopts_an_anchor_from_the_scratch_repo_head():
    """An unanchored entity stays unanchored — the scratch HEAD is not evidence.

    The regression this pins: the baseline used to be backfilled from
    `rev-parse HEAD` when the DB had no row. But `_sync_remote_branch` resets this
    shared scratch repo to FETCH_HEAD on every status/diff/push, so its HEAD tracks
    the REMOTE, not what was applied to the database. A status call landing first
    (both run from the same mount, on the same repo lock) left HEAD == remote_head,
    the adoption fired, and the route PERSISTED it — clearing the behind banner and
    disarming the pull-first guard for content that was never imported."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        remote = _bare_remote(tmp)
        pushed = await g.commit_push(getter, "u", _zip({"project.json": '{"a":1}'}), "main", "init", remote, None)
        head = pushed["commit"]["oid"]

        s = await g.sync_state(getter, "u", "main", remote, None)  # synced_oid=None
        assert s["remoteHead"] == head
        # No anchor is invented, and none is handed back for the route to persist.
        assert s["syncedOid"] is None
        assert "adoptedOid" not in s
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_sync_state_unanchored_reports_nothing_rather_than_a_false_sync():
    """Unanchored + the remote has moved: report neither behind nor in-sync.

    Reporting nothing is honest — the server cannot know which commit's content
    the database holds. The old code adopted the scratch HEAD here and, when a
    status call had already reset it to the remote head, silently swallowed the
    remote's changes for good. An entity gets its anchor when a pull or an import
    applies content (set-sync-state), not from this read-only check."""
    tmp = Path(tempfile.mkdtemp())
    local, other = tmp / "repo", tmp / "other"

    try:
        remote = _bare_remote(tmp)
        first = await g.commit_push(lambda _u: local, "u", _zip({"project.json": '{"a":1}'}), "main", "v1", remote, None)
        v1 = first["commit"]["oid"]
        second = await g.commit_push(lambda _u: other, "o", _zip({"project.json": '{"a":2}'}), "main", "v2", remote, None)
        v2 = second["commit"]["oid"]
        assert v1 != v2

        s = await g.sync_state(lambda _u: local, "u", "main", remote, None)
        assert s["remoteHead"] == v2
        assert s["syncedOid"] is None
        assert s["behind"] is False and s["diverged"] is False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_sync_state_with_a_real_anchor_still_detects_behind():
    """The anchor path that DOES carry evidence keeps working: an oid recorded by a
    pull/import is compared against the remote head as before."""
    tmp = Path(tempfile.mkdtemp())
    local, other = tmp / "repo", tmp / "other"

    try:
        remote = _bare_remote(tmp)
        first = await g.commit_push(lambda _u: local, "u", _zip({"project.json": '{"a":1}'}), "main", "v1", remote, None)
        v1 = first["commit"]["oid"]
        second = await g.commit_push(lambda _u: other, "o", _zip({"project.json": '{"a":2}'}), "main", "v2", remote, None)
        v2 = second["commit"]["oid"]

        s = await g.sync_state(lambda _u: local, "u", "main", remote, v1)
        assert s["remoteHead"] == v2 and s["syncedOid"] == v1
        assert s["behind"] is True and s["diverged"] is False
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
async def test_commit_push_accepts_a_reviewed_but_not_synced_anchor():
    """A partial pull leaves `synced_oid` behind on purpose — the push must still go.

    The user took some incoming items and knowingly kept their own version of the
    rest, so they hold none of that commit's content (`synced_oid` unchanged) but
    have deliberated over all of it (`reviewed_oid` = the remote head). Gating on
    the content cursor alone refused every later push while the banner read "up to
    date", escapable only by the complete pull they had just declined. The items
    they kept are exactly what this push is for.
    """
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        remote = _bare_remote(tmp)
        first = await g.commit_push(getter, "u", _zip({"project.json": '{"a":1}'}), "main", "v1", remote, None)
        stale_synced = first["commit"]["oid"]

        tmp2 = Path(tempfile.mkdtemp())
        try:
            def getter2(_uid):
                return tmp2 / "repo"
            second = await g.commit_push(getter2, "u", _zip({"project.json": '{"a":2}'}), "main", "v2", remote, None)
            reviewed = second["commit"]["oid"]
        finally:
            shutil.rmtree(tmp2, ignore_errors=True)

        # Content anchor still on v1, decision cursor on v2 (everything decided).
        r = await g.commit_push(
            getter, "u", _zip({"project.json": '{"a":3}'}), "main", "v3",
            remote, None, None, stale_synced, reviewed,
        )
        assert r["committed"], "a fully-reviewed partial pull must not block the push"

        # But a decision cursor that is ALSO behind still refuses: there is
        # remote work nobody has looked at.
        with pytest.raises(g.GitError) as exc:
            await g.commit_push(
                getter, "u", _zip({"project.json": '{"a":4}'}), "main", "v4",
                remote, None, None, stale_synced, stale_synced,
            )
        assert exc.value.code == "pull_required"
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


# --- Source-concept row diff (twin of source-concepts-diff.ts) ---------------

_HEADER = "vocabulary_id,concept_code,concept_name,domain"
_COLUMN_MAPPING = {
    "terminologyColumn": "vocabulary_id",
    "conceptCodeColumn": "concept_code",
    "conceptNameColumn": "concept_name",
}


def _csv(*rows: str) -> str:
    return "\n".join([_HEADER, *rows])


def test_key_source_concepts_keys_by_vocabulary_and_code():
    rows = g._key_source_concepts(_csv("LOCAL,VC,Volume courant,Measurement"))
    assert rows is not None
    assert set(rows) == {"LOCAL|VC"}


def test_key_source_concepts_accepts_alternative_headers():
    assert g._key_source_concepts("terminology,code\nLOCAL,VC") is not None
    assert g._key_source_concepts("Vocabulary_ID,Concept_Code\nLOCAL,VC") is not None


def test_key_source_concepts_handles_quoted_commas():
    rows = g._key_source_concepts(_csv('LOCAL,VC,"Volume, courant",Measurement'))
    assert rows is not None and len(rows) == 1
    assert "Volume, courant" in rows["LOCAL|VC"]


def test_key_source_concepts_unkeyable_inputs():
    """An LFS pointer, an empty file or a CSV without the identity columns must
    yield None so the UI falls back to a whole-file choice."""
    assert g._key_source_concepts("version https://git-lfs.github.com/spec/v1\noid x") is None
    assert g._key_source_concepts("") is None
    assert g._key_source_concepts(None) is None
    assert g._key_source_concepts("concept_name,domain\nVolume,Measurement") is None


def test_key_source_concepts_survives_binary_content():
    """Some sites export source-concepts.csv as Parquet under the .csv name. Its
    bytes decode into stray newlines that csv.reader rejects mid-parse; that has
    to read as "unkeyable", not raise out of the pull-preview endpoint."""
    # A bare \r inside an unquoted field is what csv.reader refuses; real Parquet
    # bytes are riddled with them once decoded as text.
    parquet = 'PAR1\x15\x00"a\rb"x\rvocabulary_id,concept_code\r\nLOCAL,VC'
    assert g._key_source_concepts(parquet) is None
    assert g._key_source_concepts_named(parquet, _COLUMN_MAPPING) is None


def test_diff_source_concepts_reports_not_comparable_for_binary_side():
    parquet = b"PAR1\r\x00\rcode\r\nA\x00\r\rB".decode("utf-8", "replace")
    csv_text = _csv("LOCAL,A,Alpha,M")
    d = g._diff_source_concepts(parquet, csv_text, _COLUMN_MAPPING)
    assert d["keyed"] is False
    assert d["localTotal"] == 0 and d["remoteTotal"] == 1
    d = g._diff_source_concepts(csv_text, parquet, _COLUMN_MAPPING)
    assert d["keyed"] is False
    assert d["localTotal"] == 1 and d["remoteTotal"] == 0


def test_key_source_concepts_skips_rows_without_a_code():
    rows = g._key_source_concepts(_csv("LOCAL,,No code,M", "LOCAL,VC,Volume,M"))
    assert rows is not None and set(rows) == {"LOCAL|VC"}


def test_diff_source_concepts_counts_added_removed_modified():
    local = _csv("LOCAL,A,Alpha,M", "LOCAL,B,Beta,M", "LOCAL,C,Gamma,M")
    remote = _csv("LOCAL,A,Alpha,M", "LOCAL,B,Beta renamed,M", "LOCAL,D,Delta,M")
    d = g._diff_source_concepts(local, remote)
    assert d["keyed"] is True
    assert (d["added"], d["removed"], d["modified"], d["unchanged"]) == (1, 1, 1, 1)
    assert d["localTotal"] == 3 and d["remoteTotal"] == 3


def test_diff_source_concepts_same_code_other_vocabulary_is_a_different_concept():
    d = g._diff_source_concepts(_csv("LOINC,1234-5,X,M"), _csv("SNOMED,1234-5,X,M"))
    assert (d["added"], d["removed"], d["modified"]) == (1, 1, 0)


def test_diff_source_concepts_identical_sides_report_no_change():
    same = _csv("LOCAL,A,Alpha,M")
    d = g._diff_source_concepts(same, same)
    assert (d["added"], d["removed"], d["modified"]) == (0, 0, 0)
    assert d["unchanged"] == 1


def test_diff_source_concepts_not_keyed_when_a_side_is_unreadable():
    d = g._diff_source_concepts(None, _csv("LOCAL,A,Alpha,M"))
    assert d["keyed"] is False


def test_diff_matches_the_typescript_twin_on_the_same_fixture():
    """The TS twin (source-concepts-diff.test.ts) asserts these exact numbers on
    this exact fixture; the two implementations must not drift apart."""
    local = _csv("LOCAL,A,Alpha,Measurement", "LOCAL,B,Beta,Measurement", "LOCAL,C,Gamma,Measurement")
    remote = _csv("LOCAL,A,Alpha,Measurement", "LOCAL,B,Beta renamed,Measurement", "LOCAL,D,Delta,Measurement")
    d = g._diff_source_concepts(local, remote)
    assert {k: d[k] for k in ("added", "removed", "modified", "unchanged")} == {
        "added": 1, "removed": 1, "modified": 1, "unchanged": 1,
    }


# --- reviewed_oid: the decision cursor, split from the content anchor --------


@pytest.mark.asyncio
async def test_sync_state_measures_behind_against_the_reviewed_cursor():
    """A partial pull leaves the content anchor behind on purpose but records the
    decision cursor at the remote head. The banner must clear and the push unblock,
    even though `synced_oid` deliberately stayed put — that is the whole point of
    the split (see models/git_sync_state.py)."""
    tmp = Path(tempfile.mkdtemp())
    local, other = tmp / "repo", tmp / "other"

    try:
        remote = _bare_remote(tmp)
        first = await g.commit_push(lambda _u: local, "u", _zip({"project.json": '{"a":1}'}), "main", "v1", remote, None)
        v1 = first["commit"]["oid"]
        second = await g.commit_push(lambda _u: other, "o", _zip({"project.json": '{"a":2}'}), "main", "v2", remote, None)
        v2 = second["commit"]["oid"]

        # Anchor still at v1 (we did NOT take everything) but every incoming item
        # was decided on → not behind.
        s = await g.sync_state(lambda _u: local, "u", "main", remote, v1, reviewed_oid=v2)
        assert s["behind"] is False and s["diverged"] is False
        # Both cursors are echoed truthfully: the anchor did not move.
        assert s["syncedOid"] == v1 and s["reviewedOid"] == v2
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_sync_state_falls_back_to_the_anchor_when_never_reviewed():
    """Rows predating the split (reviewed_oid NULL) keep their old behaviour."""
    tmp = Path(tempfile.mkdtemp())
    local, other = tmp / "repo", tmp / "other"

    try:
        remote = _bare_remote(tmp)
        first = await g.commit_push(lambda _u: local, "u", _zip({"project.json": '{"a":1}'}), "main", "v1", remote, None)
        v1 = first["commit"]["oid"]
        await g.commit_push(lambda _u: other, "o", _zip({"project.json": '{"a":2}'}), "main", "v2", remote, None)

        s = await g.sync_state(lambda _u: local, "u", "main", remote, v1, reviewed_oid=None)
        assert s["behind"] is True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_sync_state_behind_again_when_the_remote_moves_past_the_review():
    """Deciding on v2 does not immunise against v3: a later remote commit brings
    items the user has never seen, so it must be offered."""
    tmp = Path(tempfile.mkdtemp())
    local, other = tmp / "repo", tmp / "other"

    try:
        remote = _bare_remote(tmp)
        first = await g.commit_push(lambda _u: local, "u", _zip({"project.json": '{"a":1}'}), "main", "v1", remote, None)
        v1 = first["commit"]["oid"]
        second = await g.commit_push(lambda _u: other, "o", _zip({"project.json": '{"a":2}'}), "main", "v2", remote, None)
        v2 = second["commit"]["oid"]
        await g.commit_push(lambda _u: other, "o", _zip({"project.json": '{"a":3}'}), "main", "v3", remote, None)

        s = await g.sync_state(lambda _u: local, "u", "main", remote, v1, reviewed_oid=v2)
        assert s["behind"] is True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_sync_state_rejects_a_malicious_reviewed_oid():
    """The new cursor reaches git as a positional refspec like the anchor, so it
    needs the same validation — an option-looking value must not slip through."""
    with pytest.raises(g.GitError):
        await g.sync_state(
            lambda _u: Path("/tmp/nope"), "u", "main",
            "https://example.invalid/r.git", None, reviewed_oid="--upload-pack=x",
        )


def test_diff_lists_the_rows_that_moved_with_their_names():
    """Counts alone don't let a user judge a pull — "5 concepts disappear" is only
    actionable if they can see WHICH ones."""
    header = "vocabulary_id,concept_code,concept_name,domain"
    local = "\n".join([header, "LOCAL,A,Alpha,M", "LOCAL,B,Beta,M", "LOCAL,C,Gamma,M"])
    remote = "\n".join([header, "LOCAL,A,Alpha,M", "LOCAL,B,Beta renamed,M", "LOCAL,D,Delta,M"])
    d = g._diff_source_concepts(local, remote)

    by_state = {c["state"]: c for c in d["changes"]}
    assert by_state["add"]["code"] == "D" and by_state["add"]["name"] == "Delta"
    assert by_state["modify"]["code"] == "B" and by_state["modify"]["name"] == "Beta renamed"
    # A removed row is gone remotely, so its name can only come from the LOCAL side.
    assert by_state["delete"]["code"] == "C" and by_state["delete"]["name"] == "Gamma"
    assert d["changesTruncated"] is False


def test_diff_omits_unchanged_rows_from_the_listing():
    header = "vocabulary_id,concept_code,concept_name"
    same = "\n".join([header, "LOCAL,A,Alpha", "LOCAL,B,Beta"])
    d = g._diff_source_concepts(same, same)
    assert d["changes"] == []


def test_diff_caps_the_listing_but_never_the_counts():
    """A 60 000-row list would be pointless to scroll and expensive to ship, so the
    listing is capped — but the counts must stay exact or the cap would understate
    the change the user is accepting."""
    header = "vocabulary_id,concept_code,concept_name"
    n = g._MAX_LISTED_CONCEPT_CHANGES + 50
    remote = "\n".join([header, *(f"LOCAL,C{i},Name {i}" for i in range(n))])
    d = g._diff_source_concepts(header, remote)  # local: header only = empty
    assert d["added"] == n
    assert len(d["changes"]) == g._MAX_LISTED_CONCEPT_CHANGES
    assert d["changesTruncated"] is True


def test_diff_tolerates_a_csv_without_a_name_column():
    """The name is optional — its absence must not drop the row from the listing."""
    local = "vocabulary_id,concept_code\nLOCAL,A"
    remote = "vocabulary_id,concept_code\nLOCAL,A\nLOCAL,B"
    d = g._diff_source_concepts(local, remote)
    assert [c["code"] for c in d["changes"]] == ["B"]
    assert d["changes"][0]["name"] == ""


def test_unkeyable_diff_lists_nothing():
    d = g._diff_source_concepts(None, "vocabulary_id,concept_code\nLOCAL,A")
    assert d["keyed"] is False and d["changes"] == []


def test_keying_uses_the_project_column_mapping_not_guessed_names():
    """A source CSV is the USER's file: its headers are whatever they were on
    import. The real RiCDC/mimic-iv export uses `terminology_code`, which is in no
    guess list — keying it by name alone declared a perfectly good file "not
    comparable", so the pull offered no row diff at all."""
    csv_text = "terminology_code,concept_code,concept_label\nmimic_outputevents,226559,Foley"
    mapping = {
        "terminologyColumn": "terminology_code",
        "conceptCodeColumn": "concept_code",
        "conceptNameColumn": "concept_label",
    }
    assert g._key_source_concepts_named(csv_text) is None  # guesses alone: unkeyable
    keyed = g._key_source_concepts_named(csv_text, mapping)
    assert keyed is not None
    rows, names = keyed
    assert set(rows) == {"mimic_outputevents|226559"}
    assert names["mimic_outputevents|226559"] == "Foley"


def test_column_mapping_falls_back_to_guessed_names_when_stale():
    """A mapping naming a column the CSV no longer has must not break keying —
    the standard names still resolve it."""
    csv_text = "vocabulary_id,concept_code,concept_name\nLOCAL,A,Alpha"
    stale = {"terminologyColumn": "gone_column", "conceptCodeColumn": "also_gone"}
    keyed = g._key_source_concepts_named(csv_text, stale)
    assert keyed is not None and set(keyed[0]) == {"LOCAL|A"}


def test_diff_with_a_user_named_csv_reports_real_row_changes():
    header = "terminology_code,concept_code,concept_label"
    mapping = {
        "terminologyColumn": "terminology_code",
        "conceptCodeColumn": "concept_code",
        "conceptNameColumn": "concept_label",
    }
    local = "\n".join([header, "mimic,A,Alpha", "mimic,B,Beta"])
    remote = "\n".join([header, "mimic,A,Alpha", "mimic,C,Gamma"])
    d = g._diff_source_concepts(local, remote, mapping)
    assert (d["added"], d["removed"], d["modified"]) == (1, 1, 0)
    assert {c["code"] for c in d["changes"]} == {"B", "C"}


def test_condense_hunks_skips_the_untouched_head_and_tail():
    """difflib is ~O(n*m) and these files are generated: a 59 000-line
    mappings.json where 3 blocks changed cost 5.5s to diff line-by-line, because
    every identical line was still compared. Trimming the common affixes first
    brings the same file down to ~80 compared lines (13ms)."""
    old = "\n".join(["same"] * 5000 + ["OLD"] + ["tail"] * 5000)
    new = "\n".join(["same"] * 5000 + ["NEW"] + ["tail"] * 5000)
    old_h, new_h, truncated = g._condense_hunks(old, new)
    assert truncated is False
    assert "OLD" in old_h and "NEW" in new_h
    # Only the changed block plus its context survives, not the 10 000 same lines.
    assert len(old_h.split("\n")) < 20


def test_condense_hunks_keeps_real_line_numbers_after_trimming():
    """The @@ markers must still point at the file's real lines, or the viewer
    would place every change at the top."""
    old = "\n".join(["same"] * 100 + ["OLD"])
    new = "\n".join(["same"] * 100 + ["NEW"])
    old_h, _, _ = g._condense_hunks(old, new)
    marker = old_h.split("\n")[0]
    assert marker.startswith("@@ -") and "-98" in marker  # 100 lines + context


def test_condense_hunks_handles_a_change_at_the_very_start():
    old_h, new_h, _ = g._condense_hunks("OLD\nsame\nsame", "NEW\nsame\nsame")
    assert "OLD" in old_h and "NEW" in new_h


def test_condense_hunks_on_identical_text_produces_nothing():
    old_h, new_h, truncated = g._condense_hunks("a\nb\nc", "a\nb\nc")
    assert old_h == "" and new_h == "" and truncated is False


def test_condense_hunks_finds_several_separated_changes():
    old = "\n".join(["A"] + ["x"] * 50 + ["B"] + ["y"] * 50 + ["C"])
    new = "\n".join(["A2"] + ["x"] * 50 + ["B2"] + ["y"] * 50 + ["C"])
    old_h, new_h, _ = g._condense_hunks(old, new)
    assert "A" in old_h and "B" in old_h
    assert "A2" in new_h and "B2" in new_h
    # Each marker contains "@@" twice, so two blocks read as four occurrences.
    assert len([l for l in old_h.split("\n") if l.startswith("@@")]) == 2


@pytest.mark.asyncio
async def test_diff_accepts_a_zip_holding_only_the_requested_file():
    """The diff endpoint assembles ONE file, not the whole export: a real project's
    tree is ~38 MB (the source CSV alone is 35 MB) and rebuilding it per click cost
    about a minute. Since _unpack_zip_into wipes the tree first, the change type
    must come from this file alone — a global `git add -A` status would report
    every absent file as deleted."""
    tmp = Path(tempfile.mkdtemp())
    try:
        remote = _bare_remote(tmp)
        await g.commit_push(
            lambda _u: tmp / "repo", "u",
            _zip({"project.json": '{"a":1}', "mappings.json": "[]", "source-concepts.csv": "v,c\nA,1"}),
            "main", "v1", remote, None,
        )
        # A partial ZIP: only the file being diffed.
        out = await g.diff(
            lambda _u: tmp / "repo", "u",
            _zip({"mappings.json": '[{"x":1}]'}),
            "main", "mappings.json", remote, None,
        )
        assert out["changeType"] == "modified"  # NOT "added", and not "deleted"
        assert out["oldContent"] == "[]"
        assert '"x": 1' in out["newContent"] or '"x":1' in out["newContent"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_diff_reports_added_for_a_file_absent_from_head():
    tmp = Path(tempfile.mkdtemp())
    try:
        remote = _bare_remote(tmp)
        await g.commit_push(lambda _u: tmp / "repo", "u", _zip({"project.json": "{}"}), "main", "v1", remote, None)
        out = await g.diff(
            lambda _u: tmp / "repo", "u", _zip({"mappings.json": "[]"}),
            "main", "mappings.json", remote, None,
        )
        assert out["changeType"] == "added"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_rename_reports_old_path_and_diffs_against_it():
    """A renamed file must diff against its content at the OLD path.

    git reports a rename under its NEW name only, so looking HEAD up by that name
    finds nothing and the viewer renders the whole file as added — a blank left
    pane. This is the `project.json` → `entity.json` move: git pairs the two by
    similarity, so the content legitimately changed too, and that before/after is
    exactly what the user needs to see.
    """
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        # Enough shared lines that git's similarity detection pairs the two files;
        # a wholly-rewritten file is reported as add+delete instead, not a rename.
        original = '{\n  "name": "demo",\n  "kind": "project",\n  "id": "local-1"\n}'
        renamed = '{\n  "name": "demo",\n  "kind": "project",\n  "entityId": "demo"\n}'

        await g.commit_push(getter, "u", _zip({"project.json": original}), "main", "first", None, None)

        st = await g.status(getter, "u", _zip({"entity.json": renamed}), "main", None)
        entry = next(f for f in st["files"] if f["path"] == "entity.json")
        assert entry["changeType"] == "renamed"
        assert entry["oldPath"] == "project.json"

        d = await g.diff(
            getter, "u", _zip({"entity.json": renamed}), "main", "entity.json", None,
            old_path=entry["oldPath"],
        )
        # The whole point: a real before/after, not an empty left pane.
        assert d["oldContent"] == original
        assert d["newContent"] == renamed
        assert d["changeType"] == "renamed"
        assert d["oldPath"] == "project.json"

        # Without the old path the "before" side is unfindable — the bug this guards.
        blind = await g.diff(
            getter, "u", _zip({"entity.json": renamed}), "main", "entity.json", None
        )
        assert blind["oldContent"] == ""
        assert blind["changeType"] == "added"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.mark.asyncio
async def test_pure_rename_reports_no_content_change_against_old_path():
    """Identical bytes under a new name: the diff must say "nothing changed"
    rather than show the file as freshly added."""
    tmp = Path(tempfile.mkdtemp())

    def getter(_uid):
        return tmp / "repo"

    try:
        body = "line one\nline two\nline three\n"
        await g.commit_push(getter, "u", _zip({"project.json": body}), "main", "first", None, None)

        st = await g.status(getter, "u", _zip({"entity.json": body}), "main", None)
        entry = next(f for f in st["files"] if f["path"] == "entity.json")
        assert entry["changeType"] == "renamed" and entry["oldPath"] == "project.json"

        d = await g.diff(
            getter, "u", _zip({"entity.json": body}), "main", "entity.json", None,
            old_path="project.json",
        )
        assert d["truncationMode"] == "no_content_change"
        assert d["oldPath"] == "project.json"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_porcelain_keeps_old_path_only_for_renames():
    """The rename source field must be attached to its own record, not leak onto
    the next file: `-z` emits it as a bare extra field between entries."""
    tmp = Path(tempfile.mkdtemp())
    repo = tmp / "repo"
    try:
        g._ensure_repo(repo, None)
        g._unpack_zip_into(_zip({"a.txt": "keep\nthis\nfile\n", "b.txt": "other"}), repo)
        g._run(repo, "add", "-A")
        g._run(repo, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
        g._unpack_zip_into(_zip({"renamed.txt": "keep\nthis\nfile\n", "b.txt": "changed"}), repo)
        g._run(repo, "add", "-A")

        files = {f["path"]: f for f in g._porcelain_status(repo)}
        assert files["renamed.txt"]["oldPath"] == "a.txt"
        # The modified sibling must NOT have picked up the rename's source field.
        assert "oldPath" not in files["b.txt"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
