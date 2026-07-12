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
import shutil
import subprocess
import zipfile
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

from app.config import settings

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
    """A git invocation failed; message carries the (credential-scrubbed) stderr."""


def _project_repo(project_uid: str) -> Path:
    from app.services import project_fs

    return project_fs.cache_dir(project_uid) / "versioning"


def _workspace_repo(workspace_id: str) -> Path:
    d = settings.data_path / "workspaces" / workspace_id / "versioning"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _with_credentials(url: str, token: str | None) -> str:
    """Inject an access token into an https remote URL for a single call.

    GitHub/GitLab accept the token as the HTTP basic username (any password),
    matching the isomorphic-git client behaviour Linkr used before. Non-https
    URLs (ssh) are returned unchanged — the token doesn't apply there.
    """
    if not token:
        return url
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return url
    userinfo = f"{quote(token, safe='')}:x-oauth-basic@"
    netloc = parts.netloc.rsplit("@", 1)[-1]  # drop any existing credentials
    return urlunsplit((parts.scheme, userinfo + netloc, parts.path, parts.query, parts.fragment))


def _scrub(text: str, token: str | None) -> str:
    if token and token in text:
        text = text.replace(token, "***")
    return text


def _git_env() -> dict:
    """Environment that keeps git non-interactive: a bad/missing token on a
    private remote must fail fast, never block on a credential prompt."""
    import os

    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "true",
        "HOME": os.environ.get("HOME", "/tmp"),
    }


def _run(repo: Path, *args: str, token: str | None = None, check: bool = True) -> str:
    """Run a git command in `repo`; return stdout. Raise GitError on failure.

    Credentials that may appear in args/output are scrubbed from any error.
    """
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT,
            env=_git_env(),
        )
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git {args[0]} timed out") from exc
    if check and proc.returncode != 0:
        raise GitError(_scrub(proc.stderr.strip() or proc.stdout.strip(), token))
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
    fetch_url = _with_credentials(remote_url, token)
    out = _run(repo, "ls-remote", "--heads", fetch_url, branch, token=token, check=False)
    if f"refs/heads/{branch}" not in out:
        # Remote branch doesn't exist yet (first push) — start from an empty tree.
        _run(repo, "checkout", "-B", branch, check=False)
        _run(repo, "rm", "-r", "-q", "--cached", ".", check=False)
        return False
    _run(repo, "fetch", "-q", fetch_url, branch, token=token)
    # Reset index+HEAD to the fetched commit but keep the working tree (we replace
    # it with the export next), so status compares export vs the remote content.
    _run(repo, "checkout", "-B", branch, check=False)
    _run(repo, "reset", "-q", "--mixed", "FETCH_HEAD")
    return True


def _stage_paths(repo: Path, paths: list[str]) -> None:
    """Stage exactly the given paths: `add` if present in the working tree,
    `rm --cached`+worktree delete if the path is a deletion (gone from the export
    but tracked in HEAD)."""
    for rel in paths:
        if (repo / rel).is_file():
            _run(repo, "add", "--", rel)
        else:
            _run(repo, "rm", "-q", "--", rel, check=False)


def _ensure_repo(repo: Path, remote_url: str | None) -> None:
    """Init the repo (idempotent) and set/refresh 'origin' without credentials."""
    repo.mkdir(parents=True, exist_ok=True)
    if not (repo / ".git").is_dir():
        _run(repo, "init", "-q")
        _run(repo, "config", "user.name", _COMMIT_NAME)
        _run(repo, "config", "user.email", _COMMIT_EMAIL)
        # Default branch name is set on first commit via `checkout -B`.
    if remote_url:
        current = _run(repo, "remote", "get-url", "origin", check=False).strip()
        if not current:
            _run(repo, "remote", "add", "origin", remote_url)
        elif current != remote_url:
            _run(repo, "remote", "set-url", "origin", remote_url)


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
            dest = (tree / name).resolve()
            if tree.resolve() not in dest.parents and dest != tree.resolve():
                raise GitError(f"ZIP entry escapes tree: {name}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(name))


_STATUS_CODE = {"M": "modified", "A": "added", "D": "deleted", "R": "renamed", "??": "added"}


def _porcelain_status(repo: Path) -> list[dict]:
    """Parse `git status --porcelain` into [{path, changeType}] against HEAD+worktree."""
    out = _run(repo, "status", "--porcelain")
    files: list[dict] = []
    for line in out.splitlines():
        if not line.strip():
            continue
        code = line[:2].strip() or line[:2]
        path = line[3:].strip()
        if " -> " in path:  # rename: report the new path
            path = path.split(" -> ", 1)[1]
        files.append({"path": path, "changeType": _STATUS_CODE.get(code, "modified")})
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


# Beyond this, a side-by-side diff is neither useful nor cheap (LCS is O(n²)
# memory), and shipping megabytes of a CSV to the browser would freeze the UI.
_DIFF_MAX_BYTES = 256 * 1024


def _diff_payload(text: str) -> tuple[str, bool, bool]:
    """(content, too_large, binary) for one side of a diff. Binary or oversized
    content is dropped so the UI shows a placeholder instead of choking."""
    if "\x00" in text[:8192]:
        return "", False, True
    if len(text.encode("utf-8", errors="ignore")) > _DIFF_MAX_BYTES:
        return "", True, False
    return text, False, False


async def diff(repo_getter, uid: str, zip_bytes: bytes, branch: str, path: str, remote_url: str | None, token: str | None = None) -> dict:
    """Old (remote HEAD) vs new (export) content for one file in the export tree.

    Oversized/binary files return no content (too_large/binary flags) so the
    viewer never tries to render a multi-megabyte or non-text diff."""

    def work() -> dict:
        repo = repo_getter(uid)
        _ensure_repo(repo, remote_url)
        _sync_remote_branch(repo, branch, remote_url, token)
        old_raw = _run(repo, "show", f"HEAD:{path}", check=False)
        _unpack_zip_into(zip_bytes, repo)
        _run(repo, "add", "-A")
        status_files = {f["path"]: f["changeType"] for f in _porcelain_status(repo)}
        new_file = repo / path
        new_raw = new_file.read_text(encoding="utf-8", errors="replace") if new_file.is_file() else ""
        old, old_big, old_bin = _diff_payload(old_raw)
        new, new_big, new_bin = _diff_payload(new_raw)
        return {
            "path": path,
            "changeType": status_files.get(path, "modified"),
            "oldContent": old,
            "newContent": new,
            "tooLarge": old_big or new_big,
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
        ls_url = _with_credentials(url, token)
        proc = subprocess.run(
            ["git", "ls-remote", "--symref", ls_url, "HEAD"],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT,
            env=_git_env(),
        )
        if proc.returncode != 0:
            raise GitError(_scrub(proc.stderr.strip() or "remote not reachable", token))
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
            clone_url = _with_credentials(url, token)
            args = ["clone", "--depth", "1", "--single-branch"]
            if branch:
                args += ["--branch", branch]
            args += [clone_url, str(tmp / "repo")]
            # Run from tmp (not an existing repo) — plain `git clone`.
            proc = subprocess.run(
                ["git", *args], capture_output=True, text=True, timeout=_GIT_TIMEOUT, env=_git_env()
            )
            if proc.returncode != 0:
                raise GitError(_scrub(proc.stderr.strip(), token))
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


# Repo-getter bindings for the two scopes (passed to the generic ops above).
def project_repo_getter(uid: str) -> Path:
    return _project_repo(uid)


def workspace_repo_getter(uid: str) -> Path:
    return _workspace_repo(uid)
