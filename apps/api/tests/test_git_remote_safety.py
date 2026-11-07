"""Where the server's git traffic may go, and what a shared repository keeps.

- the repository of an entity holds only what its current remote serves;
- a remote host is judged as git's http client will read it;
- an LFS upload goes only to an address that passes the same check as a remote."""

import hashlib
import io
import json
import socket
import subprocess
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.config import settings
from app.services import git_service as g


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


def _remote_with(tmp_path, name: str, files: dict[str, str]) -> tuple[str, str]:
    work = tmp_path / f"{name}-work"
    subprocess.run(["git", "init", "-q", "-b", "main", str(work)], check=True)
    for path, content in files.items():
        (work / path).write_text(content)
    subprocess.run(["git", "-C", str(work), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(work), "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "c"], check=True)
    bare = tmp_path / f"{name}.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(work), str(bare)], check=True)
    oid = subprocess.run(["git", "-C", str(bare), "rev-parse", "main"], capture_output=True, text=True, check=True).stdout.strip()
    return f"file://{bare}", oid


# --- the repository is bound to its remote -------------------------------------


@pytest.fixture
def getter(tmp_path):
    repo = tmp_path / "entity-repo"
    return lambda _uid: repo


async def test_an_unlinked_entity_keeps_nothing_its_former_remote_served(tmp_path, getter):
    private, _ = _remote_with(tmp_path, "private", {"note.txt": "private marker"})
    await g.status(getter, "e", _zip({"entity.json": "{}"}), "main", private)

    status = await g.status(getter, "e", _zip({"entity.json": "{}"}), "main", None)
    diff = await g.diff(getter, "e", _zip({"entity.json": "{}"}), "main", "note.txt", None)

    assert "note.txt" not in [f["path"] for f in status["files"]]
    assert diff["oldContent"] == ""
    branches = await g.branches(getter, "e", None, None)
    assert "private marker" not in json.dumps(branches)


async def test_a_relinked_entity_reads_nothing_of_its_former_remote(tmp_path, getter):
    private, private_head = _remote_with(tmp_path, "private", {"note.txt": "private marker"})
    public, public_head = _remote_with(tmp_path, "public", {"readme.md": "public"})
    await g.status(getter, "e", _zip({"entity.json": "{}"}), "main", private)

    with pytest.raises(g.GitError):
        await g.merged_tree(getter, "e", _zip({}), "main", public, private_head, {"note.txt": {"remote": True}})

    merged = await g.merged_tree(getter, "e", _zip({}), "main", public, public_head, {"readme.md": {"remote": True}})
    with zipfile.ZipFile(io.BytesIO(merged)) as zf:
        assert zf.read("readme.md") == b"public"


async def test_an_entity_still_linked_to_its_remote_keeps_its_repository(tmp_path, getter):
    remote, _ = _remote_with(tmp_path, "remote", {"note.txt": "v1"})
    await g.status(getter, "e", _zip({"note.txt": "v1"}), "main", remote)
    marker = getter("e") / ".git" / "linkr-kept"
    marker.write_text("x")

    status = await g.status(getter, "e", _zip({"note.txt": "v2"}), "main", remote)

    assert marker.exists()
    assert [(f["path"], f["changeType"]) for f in status["files"]] == [("note.txt", "modified")]


# --- host spellings ------------------------------------------------------------


@pytest.fixture
def listener():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen()
    server.settimeout(0.2)
    hits: list[bytes] = []
    stop = threading.Event()

    def accept():
        while not stop.is_set():
            try:
                conn, _ = server.accept()
            except OSError:
                continue
            hits.append(conn.recv(3))
            conn.close()

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    yield server.getsockname()[1], hits
    stop.set()
    thread.join(1)
    server.close()


HOST_SPELLINGS = [
    "https://%31%32%37.0.0.1:{port}/x.git",
    "https://1%32%37.0.0.1:{port}/x.git",
    "https://%6c%6f%63%61%6c%68%6f%73%74:{port}/x.git",
    "https://[::1%25lo]:{port}/x.git",
    "https://foo.localhost:{port}/x.git",
    "https://foo.localhost.:{port}/x.git",
    "https://localhost.:{port}/x.git",
]


@pytest.mark.parametrize("url", HOST_SPELLINGS)
async def test_a_host_git_would_read_as_internal_is_refused_whatever_its_spelling(listener, url):
    port, hits = listener
    url = url.format(port=port)

    with pytest.raises(g.GitError):
        g._reject_internal_host(url)
    with pytest.raises(g.GitError):
        await g.verify_remote(url, None)
    with pytest.raises(g.GitError):
        await g.clone_to_zip(url, "main", None)
    with pytest.raises(g.GitError):
        await g.read_remote_file(url, "main", "x.txt", None, 1024)
    assert hits == []


def test_a_listed_host_still_passes(monkeypatch):
    monkeypatch.setattr(settings, "git_allowed_hosts", "git.internal")
    g._reject_internal_host("https://git.internal/x.git")


def test_a_name_that_does_not_resolve_is_left_to_git(monkeypatch):
    def unresolved(*_args, **_kwargs):
        raise socket.gaierror("no such host")

    monkeypatch.setattr(g.socket, "getaddrinfo", unresolved)
    g._reject_internal_host("https://forge.example/x.git")


# --- LFS uploads ---------------------------------------------------------------


CONTENT = b"large,file\n1,2\n"
OID = hashlib.sha256(CONTENT).hexdigest()
POINTER = f"version https://git-lfs.github.com/spec/v1\noid sha256:{OID}\nsize {len(CONTENT)}\n"


class _LfsServer:
    def __init__(self):
        self.requests: list[tuple[str, str, bytes]] = []
        self.href = ""
        self.verify_href: str | None = None
        server = self

        class Handler(BaseHTTPRequestHandler):
            def _body(self) -> bytes:
                return self.rfile.read(int(self.headers.get("Content-Length") or 0))

            def _answer(self, status: int, body: bytes = b"") -> None:
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                body = self._body()
                server.requests.append(("POST", self.path, body))
                if self.path.endswith("/objects/batch"):
                    actions = {"upload": {"href": server.href, "header": {"X-Remote-Chosen": "1"}}}
                    if server.verify_href:
                        actions["verify"] = {"href": server.verify_href}
                    answer = {"transfer": "basic", "objects": [{"oid": OID, "size": len(CONTENT), "actions": actions}]}
                    self._answer(200, json.dumps(answer).encode())
                else:
                    self._answer(200)

            def do_PUT(self):
                server.requests.append(("PUT", self.path, self._body()))
                self._answer(200)

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_port
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()


@pytest.fixture
def lfs_server(monkeypatch):
    server = _LfsServer()
    server.href = f"http://127.0.0.1:{server.port}/upload/{OID}"
    monkeypatch.setattr(settings, "git_allowed_hosts", f"127.0.0.1:{server.port}")
    yield server
    server.httpd.shutdown()


@pytest.fixture
def lfs_commit(tmp_path):
    if not g._has_git_lfs():
        pytest.skip("git-lfs is not installed")
    repo = tmp_path / "lfs-repo"
    g._ensure_repo(repo, None)
    (repo / ".gitattributes").write_text("*.csv filter=lfs diff=lfs merge=lfs -text\n")
    (repo / "data.csv").write_bytes(CONTENT)
    g._run(repo, "add", "-A")
    g._run(repo, "commit", "-q", "-m", "c")
    return repo, g._run(repo, "rev-parse", "HEAD").strip()


def _push_url(server) -> str:
    return f"http://oauth2:tok@127.0.0.1:{server.port}/group/repo.git"


def test_an_lfs_object_is_uploaded_to_the_address_the_remote_names(lfs_server, lfs_commit):
    repo, head = lfs_commit
    lfs_server.verify_href = f"http://127.0.0.1:{lfs_server.port}/verify"

    g._lfs_push_http(repo, _push_url(lfs_server), head, None)

    puts = [r for r in lfs_server.requests if r[0] == "PUT"]
    assert puts == [("PUT", f"/upload/{OID}", CONTENT)]
    assert ("POST", "/verify", json.dumps({"oid": OID, "size": len(CONTENT)}).encode()) in [
        (m, p, json.dumps(json.loads(b)).encode()) for m, p, b in lfs_server.requests if p == "/verify"
    ]


@pytest.mark.parametrize("href", ["http://localhost:{port}/internal", "http://127.0.0.2:{port}/internal"])
def test_an_lfs_upload_never_goes_to_an_address_the_check_refuses(lfs_server, lfs_commit, href):
    repo, head = lfs_commit
    lfs_server.href = href.format(port=lfs_server.port)

    with pytest.raises(g.GitError):
        g._lfs_push_http(repo, _push_url(lfs_server), head, None)
    assert [r for r in lfs_server.requests if r[0] == "PUT"] == []


def test_a_verify_call_never_goes_to_an_address_the_check_refuses(lfs_server, lfs_commit):
    repo, head = lfs_commit
    lfs_server.verify_href = f"http://localhost:{lfs_server.port}/verify"

    with pytest.raises(g.GitError):
        g._lfs_push_http(repo, _push_url(lfs_server), head, None)
    assert [r for r in lfs_server.requests if r[1] == "/verify"] == []


def test_objects_the_base_already_has_are_not_sent_again(lfs_server, lfs_commit):
    repo, head = lfs_commit

    g._lfs_push_http(repo, _push_url(lfs_server), head, head)

    assert lfs_server.requests == []


def test_git_lfs_never_uploads_on_its_own_to_an_http_remote(lfs_server, lfs_commit):
    repo, head = lfs_commit
    assert g._push_env(repo, _push_url(lfs_server), head, None)["GIT_LFS_SKIP_PUSH"] == "1"
    assert "GIT_LFS_SKIP_PUSH" not in g._push_env(repo, "ssh://git@forge.example/g/r.git", head, None)
