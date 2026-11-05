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
        return git_service._lfs_pull(Path("/tmp/x"), None, "https://example.org/x.git")

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
        assert git_service._lfs_pull(Path("/tmp/x"), None, "https://example.org/x.git") == "other"


class TestLfsEndpointIsTheRemotes:
    """LFS objects come from the checked remote's own endpoint: a repository's
    committed `.lfsconfig` never chooses where the server sends a request."""

    def test_endpoint_derives_from_the_remote(self):
        from app.services import git_service

        assert git_service._lfs_endpoint("https://h.org/g/r") == "https://h.org/g/r.git/info/lfs"
        assert git_service._lfs_endpoint("https://h.org/g/r.git/") == "https://h.org/g/r.git/info/lfs"
        assert git_service._lfs_endpoint("git@h.org:g/r.git") == "git@h.org:g/r.git"

    def test_a_versioning_tree_pins_its_endpoint_to_its_remote(self, tmp_path):
        from app.services import git_service

        repo = tmp_path / "repo"
        git_service._ensure_repo(repo, "https://h.org/g/r")
        for key in ("lfs.url", "lfs.pushurl"):
            assert git_service._run(repo, "config", "--get", key).strip() == "https://h.org/g/r.git/info/lfs"

    @staticmethod
    def _listener():
        import socket
        import threading

        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(4)
        listener.settimeout(0.2)
        hits: list[int] = []
        stop = threading.Event()

        def serve():
            while not stop.is_set():
                try:
                    conn, _ = listener.accept()
                except OSError:
                    continue
                hits.append(1)
                conn.close()

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()

        def close():
            stop.set()
            thread.join(timeout=2)
            listener.close()

        return listener.getsockname()[1], hits, close

    @staticmethod
    def _repo_naming_its_own_lfs_server(tmp_path, port: int) -> str:
        import subprocess as sp

        from app.services import git_service

        env = git_service._git_env()
        src = tmp_path / "src"
        remote = tmp_path / "remote.git"
        sp.run(["git", "init", "-q", str(src)], check=True, env=env)
        sp.run(["git", "init", "--bare", "-q", str(remote)], check=True, env=env)
        (src / ".gitattributes").write_text("*.csv filter=lfs diff=lfs merge=lfs -text\n")
        (src / ".lfsconfig").write_text(f"[lfs]\n\turl = http://127.0.0.1:{port}/hook\n")
        (src / "x.csv").write_bytes(POINTER)
        (src / "entity.json").write_text("{}")
        for args in (
            ["add", "-A"],
            ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c"],
            ["push", "-q", str(remote), "HEAD:main"],
        ):
            sp.run(["git", "-C", str(src), *args], check=True, env=env)
        return str(remote)

    async def test_a_committed_lfsconfig_does_not_redirect_the_clone(self, tmp_path):
        import pytest

        from app.services import git_service

        if not git_service._has_git_lfs():
            pytest.skip("git-lfs is not installed")

        port, hits, close = self._listener()
        try:
            remote = self._repo_naming_its_own_lfs_server(tmp_path, port)
            data, _oid = await git_service.clone_to_zip(remote, "main", None)
        finally:
            close()

        assert hits == []
        assert data

    async def test_lfs_uploads_go_only_to_the_checked_remote(self, tmp_path):
        import io
        import subprocess as sp
        import zipfile

        import pytest

        from app.services import git_service

        if not git_service._has_git_lfs():
            pytest.skip("git-lfs is not installed")

        port, hits, close = self._listener()
        env = git_service._git_env()
        src, remote = tmp_path / "src", tmp_path / "remote.git"
        sp.run(["git", "init", "--bare", "-q", str(remote)], check=True, env=env)
        sp.run(["git", "init", "-q", str(src)], check=True, env=env)
        (src / ".lfsconfig").write_text(f"[lfs]\n\tpushurl = http://127.0.0.1:{port}/hook\n")
        (src / "entity.json").write_text("{}")
        for args in (
            ["add", "-A"],
            ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c"],
            ["push", "-q", str(remote), "HEAD:main"],
        ):
            sp.run(["git", "-C", str(src), *args], check=True, env=env)

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(".gitattributes", "*.csv filter=lfs diff=lfs merge=lfs -text\n")
            zf.writestr("data.csv", "a,b\n1,2\n")
        try:
            result = await git_service.commit_push(
                lambda _uid: tmp_path / "repo", "u", buf.getvalue(), "main", "m", str(remote), None,
                paths=[".gitattributes", "data.csv"],
            )
        finally:
            close()

        assert hits == []
        assert result["pushed"]
