"""An unresolved Git LFS pointer must never leave the clone as if it were the file.

It is ~130 bytes of text wearing the real file's name and extension, so it flows
into the blob store and only fails much later — a Parquet reader saying "No magic
bytes found at end of file", far from anything that could name the cause.
"""

from pathlib import Path

from app.services.git_service import _drop_unresolved_lfs_pointers, _is_lfs_pointer

POINTER = (
    b"version https://git-lfs.github.com/spec/v1\n"
    b"oid sha256:1adfb887c7b18ab9fcf3e1b78caa937316e063c4e0d8027335a0ccb1a9c65560\n"
    b"size 15956\n"
)


def test_recognises_a_pointer(tmp_path):
    p = tmp_path / "admissions.parquet"
    p.write_bytes(POINTER)
    assert _is_lfs_pointer(p)


def test_leaves_real_content_alone(tmp_path):
    parquet = tmp_path / "admissions.parquet"
    parquet.write_bytes(b"PAR1" + b"\x00" * 500)
    text = tmp_path / "entity.json"
    text.write_bytes(b'{"type": "database"}')
    assert not _is_lfs_pointer(parquet)
    assert not _is_lfs_pointer(text)


def test_a_large_file_is_never_a_pointer(tmp_path):
    """Cheap guard against reading a multi-GB file to classify it."""
    p = tmp_path / "big.parquet"
    p.write_bytes(POINTER + b"\x00" * 2048)
    assert not _is_lfs_pointer(p)


def test_drops_only_the_pointers(tmp_path):
    repo = tmp_path / "repo"
    (repo / "data").mkdir(parents=True)
    (repo / ".git").mkdir()
    (repo / "data" / "admissions.parquet").write_bytes(POINTER)
    (repo / "data" / "patients.parquet").write_bytes(POINTER)
    (repo / "data" / "real.parquet").write_bytes(b"PAR1" + b"\x00" * 100)
    (repo / "entity.json").write_bytes(b'{"type": "database"}')
    # A pointer-looking blob inside .git is git's own business, never ours.
    (repo / ".git" / "somefile").write_bytes(POINTER)

    assert _drop_unresolved_lfs_pointers(repo) == 2
    assert not (repo / "data" / "admissions.parquet").exists()
    assert not (repo / "data" / "patients.parquet").exists()
    assert (repo / "data" / "real.parquet").exists()
    assert (repo / "entity.json").exists()
    assert (repo / ".git" / "somefile").exists()


def test_nothing_to_drop_is_not_an_error(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "entity.json").write_bytes(b"{}")
    assert _drop_unresolved_lfs_pointers(repo) == 0
    assert (repo / "entity.json").exists()


class TestLfsPullFailureClassification:
    """LFS authenticates separately from git, against the repo's own /info/lfs
    batch API — and GitLab rejects the `oauth2:<token>` form there that it accepts
    for clone. A public repo cloned with a stored token therefore cloned fine and
    then failed every object, so an auth failure has to be told apart from the
    rest: it is the one the caller can retry anonymously."""

    def _run(self, monkeypatch, rc, stderr):
        import subprocess as sp
        from app.services import git_service

        def fake_run(*_a, **_k):
            return sp.CompletedProcess(args=[], returncode=rc, stdout="", stderr=stderr)

        monkeypatch.setattr(git_service.subprocess, "run", fake_run)
        return git_service._lfs_pull(Path("/tmp/x"), None)

    def test_success_reports_no_failure(self, monkeypatch):
        assert self._run(monkeypatch, 0, "") is None

    def test_gitlab_auth_error_is_retryable(self, monkeypatch):
        stderr = (
            "batch response: Authentication required: Authorization error: "
            "https://oauth2:***@framagit.org/x.git/info/lfs/objects/batch"
        )
        assert self._run(monkeypatch, 2, stderr) == "auth"

    def test_other_failures_are_not_retried_anonymously(self, monkeypatch):
        assert self._run(monkeypatch, 2, "fatal: could not resolve host") == "other"

    def test_a_timeout_is_not_fatal(self, monkeypatch):
        import subprocess as sp
        from app.services import git_service

        def fake_run(*_a, **_k):
            raise sp.TimeoutExpired(cmd="git lfs pull", timeout=1)

        monkeypatch.setattr(git_service.subprocess, "run", fake_run)
        assert git_service._lfs_pull(Path("/tmp/x"), None) == "other"
