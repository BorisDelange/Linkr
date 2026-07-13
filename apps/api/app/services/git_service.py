"""Server-side git versioning for projects and workspaces (push-only).

The versioned content is the *export tree* — the same file layout the frontend
produces when it exports an entity to a ZIP (project.json, README.md,
dashboards/…, scripts/…). The frontend still builds that ZIP (it owns the
DB→files logic); this service unpacks it into a git working tree, commits, and
pushes. So the diff a user sees in git mirrors what an export would contain.

The working tree lives under the project's hidden cache dir (never shown in the
IDE, see project_fs._IGNORE), separate from the live scripts/ tree:

    data_dir/projects/<uid>/.cache/versioning/   ← git repo for the project
    data_dir/workspaces/<id>/versioning/         ← git repo for the workspace

Auth tokens for private remotes are decrypted just-in-time and injected into the
remote URL for the single push/clone invocation; they are never written to
.git/config (we set the remote without credentials and override per-call).

All git work is blocking, so every git invocation is wrapped in
asyncio.to_thread to keep the event loop responsive (mirrors blob_store).
"""

import asyncio
import io
import ipaddress
import shutil
import socket
import subprocess
import zipfile
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import structlog

from app.config import settings

logger = structlog.get_logger()

# git identity for server-made commits (the human author is tracked separately
# in the commit message / by the app; this is just what git records locally).
_COMMIT_NAME = "Linkr"
_COMMIT_EMAIL = "versioning@linkr"

# Never let a hung git subprocess (e.g. auth prompt, dead remote) block a worker.
_GIT_TIMEOUT = 120

# One lock per repo path: status/branches/commit for the same entity can arrive
# concurrently (the sync panel fires several at mount), and two `git` processes
# writing .git/config at once collide with "could not lock config file".
_repo_locks: dict[str, asyncio.Lock] = {}


def _lock_for(repo: Path) -> asyncio.Lock:
    key = str(repo)
    lock = _repo_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _repo_locks[key] = lock
    return lock


class GitError(RuntimeError):
    """A git invocation failed. `message` is the credential-scrubbed raw stderr;
    `code` is a stable machine label the UI maps to a friendly message."""

    def __init__(self, message: str, code: str = "unknown") -> None:
        super().__init__(message)
        self.code = code


def _classify_error(text: str) -> str:
    """Map git's raw stderr to a stable error code for the UI. Order matters:
    auth-denied often also mentions the URL, so check credentials first."""
    low = text.lower()
    if any(s in low for s in ("access denied", "authentication failed", "http basic", "invalid username or password", "403")):
        return "auth_failed"
    if any(s in low for s in ("could not read from remote", "repository not found", "not found", "404")):
        return "not_found"
    if any(s in low for s in ("could not resolve host", "unable to access", "timed out", "network")):
        return "network"
    if "authentication" in low or "credential" in low:
        return "auth_failed"
    return "unknown"


def _project_repo(project_uid: str) -> Path:
    from app.services import project_fs

    return project_fs.cache_dir(project_uid) / "versioning"


def _workspace_repo(workspace_id: str) -> Path:
    d = settings.data_path / "workspaces" / workspace_id / "versioning"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _mapping_project_repo(mapping_project_id: str) -> Path:
    d = settings.data_path / "mapping-projects" / mapping_project_id / "versioning"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _sql_collection_repo(collection_id: str) -> Path:
    d = settings.data_path / "sql-collections" / collection_id / "versioning"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _entity_repo(kind: str, entity_id: str) -> Path:
    """Working-tree dir for a workspace-scoped versionable entity (kind = a stable
    folder name under data_path). One repo per entity, mirroring the others."""
    d = settings.data_path / kind / entity_id / "versioning"
    d.mkdir(parents=True, exist_ok=True)
    return d


_GH_NAV_SEGMENTS = ("tree", "blob", "commit", "commits", "pull", "pulls", "releases", "tags", "branches", "find", "raw")


def _clean_url(url: str) -> str:
    """Strip browser-navigation cruft from a pasted repo URL (defense in depth;
    the frontend cleans too). GitLab uses a `/-/` separator; GitHub uses known
    path segments. Query/fragment are dropped. SSH URLs are left untouched."""
    url = (url or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        return url
    url = url.split("?", 1)[0].split("#", 1)[0]
    cut = url.find("/-/")
    if cut != -1:
        url = url[:cut]
    parts = url.split("/")
    # parts[:3] = scheme, "", host; scan the path segments after the host. Only
    # cut at a nav keyword that is *followed* by something (so a repo literally
    # named "tree" with nothing after it survives).
    for i in range(3, len(parts) - 1):
        if parts[i] in _GH_NAV_SEGMENTS:
            url = "/".join(parts[:i])
            break
    return url.rstrip("/")


def _reject_internal_host(url: str) -> None:
    """Refuse an http(s) remote whose host resolves to a loopback/link-local/
    private/reserved address — the clone & sync flows let any authenticated user
    make the server open a connection to an arbitrary URL, so block SSRF to the
    metadata endpoint (169.254.169.254), localhost, and the internal network.

    ssh/git remotes are left to the OS (no server-side HTTP fetch); a host that
    fails to resolve is left for git to error on (network code), not blocked here.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return
    host = parts.hostname
    if not host:
        raise GitError("remote URL has no host", "network")
    try:
        infos = socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except OSError:
        return  # unresolvable → let git fail with a network error, don't leak resolvability
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_loopback or ip.is_link_local or ip.is_private or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise GitError("remote host is not allowed (internal address)", "network")


def _with_credentials(url: str, token: str | None) -> str:
    """Inject an access token into an https remote URL for a single call.

    The token goes in the *password* with a fixed ``oauth2`` username. GitLab
    requires this for push (the older ``<token>:x-oauth-basic`` form authenticates
    read/clone but is rejected on push with "HTTP Basic: Access denied"); GitHub
    accepts it too (it ignores the username for a PAT). Non-https URLs (ssh) are
    returned unchanged — the token doesn't apply there.
    """
    if not token:
        return url
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return url
    userinfo = f"oauth2:{quote(token, safe='')}@"
    netloc = parts.netloc.rsplit("@", 1)[-1]  # drop any existing credentials
    return urlunsplit((parts.scheme, userinfo + netloc, parts.path, parts.query, parts.fragment))


def _scrub(text: str, token: str | None) -> str:
    if token and token in text:
        text = text.replace(token, "***")
    return text


def _git_env() -> dict:
    """Environment that keeps git non-interactive AND isolated from the host's
    ambient credentials. Linkr must authenticate ONLY with the token the user
    supplies for the entity — never a credential helper / keychain / ~/.gitconfig
    on the machine running the backend (which in local dev would silently clone a
    "private" repo using the developer's own gitlab.com token).

    - GIT_TERMINAL_PROMPT=0 / GIT_ASKPASS=true: a missing/bad token fails fast.
    - GIT_CONFIG_NOSYSTEM + HOME=/dev/null-ish: ignore system & user gitconfig.
    - credential.helper='' via GIT_CONFIG_COUNT: disable any credential helper
      (osxkeychain, cache, store) so no ambient credentials are ever used.
    """
    import os

    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "true",
        # No user/system gitconfig → no inherited credential.helper.
        "HOME": "/nonexistent-linkr-git-home",
        "GIT_CONFIG_NOSYSTEM": "1",
        # Inject config for every invocation, independent of any machine config:
        #  0) credential.helper='' — disable keychain/cache/store (no ambient creds)
        #  1) init.defaultBranch=main — we ignore user gitconfig, so pin the default
        #     branch (git would otherwise fall back to 'master' on `git init`).
        "GIT_CONFIG_COUNT": "2",
        "GIT_CONFIG_KEY_0": "credential.helper",
        "GIT_CONFIG_VALUE_0": "",
        "GIT_CONFIG_KEY_1": "init.defaultBranch",
        "GIT_CONFIG_VALUE_1": "main",
    }


def _run(repo: Path, *args: str, token: str | None = None, check: bool = True, env_extra: dict | None = None) -> str:
    """Run a git command in `repo`; return stdout. Raise GitError on failure.

    Credentials that may appear in args/output are scrubbed from any error.
    `env_extra` adds/overrides env vars for this call (e.g. GIT_LFS_SKIP_SMUDGE).
    """
    env = _git_env()
    if env_extra:
        env.update(env_extra)
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT,
            env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git {args[0]} timed out", "network") from exc
    if check and proc.returncode != 0:
        msg = _scrub(proc.stderr.strip() or proc.stdout.strip(), token)
        raise GitError(msg, _classify_error(msg))
    return proc.stdout


def _sync_remote_branch(repo: Path, branch: str, remote_url: str | None, token: str | None) -> bool:
    """Fetch origin/<branch> and point the local branch at it, so the diff is
    computed against the *actual remote content* (an already-pushed project.json
    shows as 'modified', not 'added'). The working tree is left for the caller to
    overwrite with the export. Returns True if the remote branch exists.

    Push-only: we only read the remote here; nothing is merged back into the DB.
    """
    if not remote_url:
        return False
    _reject_internal_host(remote_url)
    fetch_url = _with_credentials(remote_url, token)
    out = _run(repo, "ls-remote", "--heads", fetch_url, branch, token=token, check=False)
    if f"refs/heads/{branch}" not in out:
        # Remote branch doesn't exist yet (first push) — start from an empty tree.
        _run(repo, "checkout", "-B", branch, check=False)
        _run(repo, "rm", "-r", "-q", "--cached", ".", check=False)
        return False
    # Skip downloading LFS objects here: status/diff only need the tree + pointers
    # to compare, not the (potentially ~100 MB) file contents. This is what makes
    # "Computing changes" fast on a repo with large LFS files.
    skip_lfs = {"GIT_LFS_SKIP_SMUDGE": "1"}
    _run(repo, "fetch", "-q", fetch_url, branch, token=token, env_extra=skip_lfs)
    # Reset index+HEAD to the fetched commit but keep the working tree (we replace
    # it with the export next), so status compares export vs the remote content.
    _run(repo, "checkout", "-B", branch, check=False, env_extra=skip_lfs)
    _run(repo, "reset", "-q", "--mixed", "FETCH_HEAD", env_extra=skip_lfs)
    return True


def _stage_paths(repo: Path, paths: list[str]) -> None:
    """Stage exactly the given paths: `add` if present in the working tree,
    `rm --cached`+worktree delete if the path is a deletion (gone from the export
    but tracked in HEAD)."""
    for rel in paths:
        if _safe_join(repo, rel).is_file():
            _run(repo, "add", "--", rel)
        else:
            _run(repo, "rm", "-q", "--", rel, check=False)


_lfs_available: bool | None = None  # cached probe result


def _has_git_lfs() -> bool:
    global _lfs_available
    if _lfs_available is None:
        try:
            proc = subprocess.run(["git", "lfs", "version"], capture_output=True, timeout=10, env=_git_env())
            _lfs_available = proc.returncode == 0
        except (OSError, subprocess.SubprocessError):
            _lfs_available = False
        if not _lfs_available:
            logger.warning(
                "git-lfs not available: large files (e.g. similarity-scores.parquet) will be "
                "committed as normal git blobs. Install git-lfs on the server (see Dockerfile.api)."
            )
    return _lfs_available


def _ensure_lfs(repo: Path) -> None:
    """Install LFS filters for this repo (idempotent). No-op if git-lfs is absent."""
    if _has_git_lfs():
        _run(repo, "lfs", "install", "--local", check=False)


def _ensure_repo(repo: Path, remote_url: str | None) -> None:
    """Init the repo (idempotent) and set/refresh 'origin' without credentials."""
    repo.mkdir(parents=True, exist_ok=True)
    if not (repo / ".git").is_dir():
        _run(repo, "init", "-q")
        _run(repo, "config", "user.name", _COMMIT_NAME)
        _run(repo, "config", "user.email", _COMMIT_EMAIL)
        # Default branch name is set on first commit via `checkout -B`.
    # Enable LFS smudge/clean filters for this repo so a .gitattributes marking
    # *.parquet (etc.) filter=lfs actually stores those as LFS objects. Best
    # effort: if git-lfs isn't installed, warn but don't block — the file would
    # then commit as a normal blob (see the Dockerfile which installs git-lfs).
    _ensure_lfs(repo)
    if remote_url:
        current = _run(repo, "remote", "get-url", "origin", check=False).strip()
        if not current:
            _run(repo, "remote", "add", "origin", remote_url)
        elif current != remote_url:
            _run(repo, "remote", "set-url", "origin", remote_url)


def _safe_join(tree: Path, rel: str) -> Path:
    """Resolve `rel` under `tree`, refusing anything that escapes it (a client
    `path`/`paths` entry could be `../../etc/passwd`). Raises GitError on escape."""
    dest = (tree / rel).resolve()
    root = tree.resolve()
    if dest != root and root not in dest.parents:
        raise GitError(f"path escapes tree: {rel}")
    return dest


def _unpack_zip_into(zip_bytes: bytes, tree: Path) -> None:
    """Replace the working tree's tracked content with the ZIP's, preserving .git.

    Everything except .git is wiped first so deletions in the export show up as
    git deletions (a stale file left on disk would never be removed otherwise).
    """
    for entry in tree.iterdir():
        if entry.name == ".git":
            continue
        if entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            entry.unlink(missing_ok=True)
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            # Reject path traversal from a crafted ZIP.
            dest = _safe_join(tree, name)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(name))


_STATUS_CODE = {"M": "modified", "A": "added", "D": "deleted", "R": "renamed", "??": "added"}


def _porcelain_status(repo: Path) -> list[dict]:
    """Parse `git status --porcelain` into [{path, changeType, size}] against
    HEAD+worktree. `size` is the working-tree byte size (0 for deletions), used
    by the UI to decide LFS tracking."""
    out = _run(repo, "status", "--porcelain")
    files: list[dict] = []
    for line in out.splitlines():
        if not line.strip():
            continue
        code = line[:2].strip() or line[:2]
        path = line[3:].strip()
        if " -> " in path:  # rename: report the new path
            path = path.split(" -> ", 1)[1]
        fp = repo / path
        size = fp.stat().st_size if fp.is_file() else 0
        files.append({"path": path, "changeType": _STATUS_CODE.get(code, "modified"), "size": size})
    return files


def _summarize(files: list[dict]) -> dict:
    counts = {"modified": 0, "added": 0, "deleted": 0}
    for f in files:
        key = f["changeType"] if f["changeType"] in counts else "modified"
        counts[key] += 1
    return counts


# --- public API (async wrappers) ------------------------------------------


async def status(repo_getter, uid: str, zip_bytes: bytes, branch: str, remote_url: str | None, token: str | None = None) -> dict:
    """Materialize the export into the repo and report what would be committed
    against the actual remote content (fetched first)."""

    def work() -> dict:
        repo = repo_getter(uid)
        _ensure_repo(repo, remote_url)
        _sync_remote_branch(repo, branch, remote_url, token)
        _unpack_zip_into(zip_bytes, repo)
        _run(repo, "add", "-A")
        files = _porcelain_status(repo)
        summary = _summarize(files)
        return {"branch": branch, "files": files, **summary}

    async with _lock_for(repo_getter(uid)):
        return await asyncio.to_thread(work)


# Shipping megabytes to the browser (and diffing them, LCS is O(n²)) would freeze
# the UI, so an oversized text file is truncated to a preview rather than dropped:
# the user still sees the head of a big CSV/JSON instead of "too large".
_DIFF_MAX_BYTES = 256 * 1024
_DIFF_MAX_LINES = 1000


def _diff_payload(text: str) -> tuple[str, bool, bool]:
    """(content, truncated, binary) for one side of a diff. Binary content is
    dropped (no preview); oversized text is truncated to the first _DIFF_MAX_LINES
    lines or _DIFF_MAX_BYTES bytes, whichever comes first, with truncated=True."""
    if "\x00" in text[:8192]:
        return "", False, True
    over_bytes = len(text.encode("utf-8", errors="ignore")) > _DIFF_MAX_BYTES
    lines = text.split("\n")
    over_lines = len(lines) > _DIFF_MAX_LINES
    if not over_bytes and not over_lines:
        return text, False, False
    # Cap by lines first, then hard-cap bytes in case a few lines are huge.
    preview = "\n".join(lines[:_DIFF_MAX_LINES])
    if len(preview.encode("utf-8", errors="ignore")) > _DIFF_MAX_BYTES:
        preview = preview.encode("utf-8", errors="ignore")[:_DIFF_MAX_BYTES].decode("utf-8", errors="ignore")
    return preview, True, False


async def diff(repo_getter, uid: str, zip_bytes: bytes, branch: str, path: str, remote_url: str | None, token: str | None = None) -> dict:
    """Old (remote HEAD) vs new (export) content for one file in the export tree.

    Oversized/binary files return no content (too_large/binary flags) so the
    viewer never tries to render a multi-megabyte or non-text diff."""

    def work() -> dict:
        repo = repo_getter(uid)
        _safe_join(repo, path)  # reject a traversing path before any git/FS use
        _ensure_repo(repo, remote_url)
        _sync_remote_branch(repo, branch, remote_url, token)
        old_raw = _run(repo, "show", f"HEAD:{path}", check=False)
        _unpack_zip_into(zip_bytes, repo)
        _run(repo, "add", "-A")
        status_files = {f["path"]: f["changeType"] for f in _porcelain_status(repo)}
        new_file = _safe_join(repo, path)
        new_raw = new_file.read_text(encoding="utf-8", errors="replace") if new_file.is_file() else ""
        # HEAD content of an LFS-tracked file is just its pointer (we fetch with
        # SKIP_SMUDGE), so a text diff against it is meaningless — flag as binary.
        if old_raw.startswith("version https://git-lfs"):
            old_raw = ""
            old_is_lfs = True
        else:
            old_is_lfs = False
        old, old_trunc, old_bin = _diff_payload(old_raw)
        new, new_trunc, new_bin = _diff_payload(new_raw)
        old_bin = old_bin or old_is_lfs
        return {
            "path": path,
            "changeType": status_files.get(path, "modified"),
            "oldContent": old,
            "newContent": new,
            "truncated": old_trunc or new_trunc,
            "binary": old_bin or new_bin,
        }

    async with _lock_for(repo_getter(uid)):
        return await asyncio.to_thread(work)


async def commit_push(
    repo_getter,
    uid: str,
    zip_bytes: bytes,
    branch: str,
    message: str,
    remote_url: str | None,
    token: str | None,
    paths: list[str] | None = None,
) -> dict:
    """Unpack the export and commit the selected files (all if paths is None) on
    top of the fetched remote branch, then push. Push-only flow."""

    def work() -> dict:
        repo = repo_getter(uid)
        _ensure_repo(repo, remote_url)
        _sync_remote_branch(repo, branch, remote_url, token)
        _unpack_zip_into(zip_bytes, repo)
        if paths is None:
            _run(repo, "add", "-A")
        else:
            # Stage only the chosen paths. Unlisted export files stay untracked
            # (not committed); an unlisted file that exists in the remote HEAD is
            # left as-is (still tracked at its remote version), so unchecking it
            # neither commits nor deletes it.
            _stage_paths(repo, paths)
        # Commit reflects the index, so gate on staged changes (a selective stage
        # can leave untracked files in the tree that must not count as "to commit").
        staged = _run(repo, "diff", "--cached", "--name-only").strip()
        if not staged:
            return {"committed": False, "pushed": False, "nothingToCommit": True}
        _run(repo, "commit", "-q", "-m", message)
        head = _run(repo, "rev-parse", "HEAD").strip()
        pushed = False
        if remote_url:
            _reject_internal_host(remote_url)
            push_url = _with_credentials(remote_url, token)
            _run(repo, "push", push_url, f"{branch}:{branch}", token=token)
            pushed = True
        return {
            "committed": True,
            "pushed": pushed,
            "nothingToCommit": False,
            "commit": {"oid": head, "message": message},
        }

    async with _lock_for(repo_getter(uid)):
        return await asyncio.to_thread(work)


async def branches(repo_getter, uid: str, remote_url: str | None, token: str | None) -> dict:
    """List branches on the remote (fallback to local) plus the current branch."""

    def work() -> dict:
        repo = repo_getter(uid)
        _ensure_repo(repo, remote_url)
        names: list[str] = []
        if remote_url:
            _reject_internal_host(remote_url)
            ls_url = _with_credentials(remote_url, token)
            out = _run(repo, "ls-remote", "--heads", ls_url, token=token, check=False)
            for line in out.splitlines():
                if "refs/heads/" in line:
                    names.append(line.split("refs/heads/", 1)[1].strip())
        if not names:
            out = _run(repo, "branch", "--format=%(refname:short)", check=False)
            names = [b.strip() for b in out.splitlines() if b.strip()]
        current = _run(repo, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip()
        return {"branches": sorted(set(names)), "current": current or None}

    async with _lock_for(repo_getter(uid)):
        return await asyncio.to_thread(work)


async def verify_remote(url: str, token: str | None) -> dict:
    """Check that the remote exists and is reachable with the given credentials,
    without cloning. Returns {ok, branches, default}. Raises GitError otherwise,
    so the caller can refuse to persist an unreachable/unauthorized link."""

    def work() -> dict:
        cleaned = _clean_url(url)
        _reject_internal_host(cleaned)
        ls_url = _with_credentials(cleaned, token)
        proc = subprocess.run(
            ["git", "ls-remote", "--symref", ls_url, "HEAD"],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT,
            env=_git_env(),
        )
        if proc.returncode != 0:
            msg = _scrub(proc.stderr.strip() or "remote not reachable", token)
            code = _classify_error(msg)
            # A private repo probed without a token reads as auth_failed; signal
            # "token required" so the UI can ask for one rather than just erroring.
            if code == "auth_failed" and not token:
                code = "auth_required"
            raise GitError(msg, code)
        default = None
        branches_found: list[str] = []
        for line in proc.stdout.splitlines():
            if line.startswith("ref:") and "refs/heads/" in line:
                default = line.split("refs/heads/", 1)[1].split()[0].strip()
            elif "refs/heads/" in line:
                branches_found.append(line.split("refs/heads/", 1)[1].strip())
        return {"ok": True, "branches": sorted(set(branches_found)), "default": default}

    return await asyncio.to_thread(work)


async def clone_to_zip(url: str, branch: str, token: str | None) -> bytes:
    """Shallow-clone a remote into a temp dir and return its content as a ZIP.

    Used by the import flow in server mode (replaces the in-browser
    isomorphic-git clone, so no CORS proxy is needed). The .git dir is excluded
    — the caller treats the result as an importable export tree.
    """

    def work() -> bytes:
        import tempfile

        tmp = Path(tempfile.mkdtemp(prefix="linkr-clone-"))
        try:
            cleaned = _clean_url(url)
            _reject_internal_host(cleaned)
            clone_url = _with_credentials(cleaned, token)
            args = ["clone", "--depth", "1", "--single-branch"]
            if branch:
                args += ["--branch", branch]
            args += [clone_url, str(tmp / "repo")]
            # Run from tmp (not an existing repo) — plain `git clone`.
            proc = subprocess.run(
                ["git", *args], capture_output=True, text=True, timeout=_GIT_TIMEOUT, env=_git_env()
            )
            if proc.returncode != 0:
                msg = _scrub(proc.stderr.strip(), token)
                raise GitError(msg, _classify_error(msg))
            repo = tmp / "repo"
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for p in repo.rglob("*"):
                    if ".git" in p.relative_to(repo).parts:
                        continue
                    if p.is_file():
                        zf.write(p, p.relative_to(repo).as_posix())
            return buf.getvalue()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    return await asyncio.to_thread(work)


# Repo-getter bindings per scope (passed to the generic ops above).
def project_repo_getter(uid: str) -> Path:
    return _project_repo(uid)


def workspace_repo_getter(uid: str) -> Path:
    return _workspace_repo(uid)


def mapping_project_repo_getter(uid: str) -> Path:
    return _mapping_project_repo(uid)


def sql_collection_repo_getter(uid: str) -> Path:
    return _sql_collection_repo(uid)


def etl_pipeline_repo_getter(uid: str) -> Path:
    return _entity_repo("etl-pipelines", uid)


def data_catalog_repo_getter(uid: str) -> Path:
    return _entity_repo("data-catalogs", uid)


def dq_rule_set_repo_getter(uid: str) -> Path:
    return _entity_repo("dq-rule-sets", uid)


def schema_preset_repo_getter(uid: str) -> Path:
    return _entity_repo("schema-presets", uid)


def user_plugin_repo_getter(uid: str) -> Path:
    return _entity_repo("user-plugins", uid)
