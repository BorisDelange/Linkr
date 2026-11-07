"""An LFS server names where its content is: Linkr only follows it past the same host check."""

import hashlib
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.config import settings
from app.services import git_service as g

CONTENT = b"name\nrow\n"
OID = hashlib.sha256(CONTENT).hexdigest()
POINTER = f"version https://git-lfs.github.com/spec/v1\noid sha256:{OID}\nsize {len(CONTENT)}\n"


class _Forge:
    """A remote's LFS endpoint: `href` is what its batch answer names."""

    def __init__(self):
        self.gets: list[str] = []
        self.batch_status = 200
        self.body = CONTENT
        self.redirect: str | None = None
        self.href = ""
        forge = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.dumps({"objects": [{
                    "oid": OID, "size": len(CONTENT),
                    "actions": {"download": {"href": forge.href, "header": {"X-Object": "1"}}},
                }]}).encode()
                self.send_response(forge.batch_status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                forge.gets.append(self.path)
                if forge.redirect:
                    self.send_response(302)
                    self.send_header("Location", forge.redirect)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(forge.body)))
                self.end_headers()
                self.wfile.write(forge.body)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def forge(monkeypatch):
    f = _Forge()
    f.href = f"http://127.0.0.1:{f.port}/object"
    monkeypatch.setattr(settings, "git_allowed_hosts", f"127.0.0.1:{f.port}")
    yield f
    f.server.shutdown()


@pytest.fixture
def repo(tmp_path):
    path = tmp_path / "repo"
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    (path / "data.csv").write_text(POINTER)
    return path


def _remote(forge) -> str:
    return f"http://127.0.0.1:{forge.port}/group/repo.git"


def test_lfs_content_lands_in_the_tree(forge, repo):
    assert g._lfs_pull(repo, None, _remote(forge)) is None
    assert (repo / "data.csv").read_bytes() == CONTENT


def test_a_download_link_to_a_host_the_check_refuses_is_not_followed(forge, repo):
    forge.href = f"http://localhost:{forge.port}/internal"
    assert g._lfs_pull(repo, None, _remote(forge)) == "other"
    assert forge.gets == []
    assert (repo / "data.csv").read_text() == POINTER


def test_a_redirect_to_a_host_the_check_refuses_is_not_followed(forge, repo):
    forge.redirect = f"http://localhost:{forge.port}/internal"
    assert g._lfs_pull(repo, None, _remote(forge)) == "other"
    assert forge.gets == ["/object"]
    assert (repo / "data.csv").read_text() == POINTER


def test_content_that_is_not_what_the_pointer_names_is_refused(forge, repo):
    forge.body = b"name\ntampered\n"[:len(CONTENT)].ljust(len(CONTENT), b"x")
    assert g._lfs_pull(repo, None, _remote(forge)) == "other"
    assert (repo / "data.csv").read_text() == POINTER


def test_refused_credentials_are_told_apart_so_the_caller_can_retry_anonymously(forge, repo):
    forge.batch_status = 401
    assert g._lfs_pull(repo, None, _remote(forge)) == "auth"


def test_no_git_command_downloads_lfs_content_on_its_own():
    assert g._git_env()["GIT_LFS_SKIP_SMUDGE"] == "1"
