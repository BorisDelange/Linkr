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
import difflib
import io
import ipaddress
import re
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


# A branch name is client-supplied and reaches git as a positional refspec (with
# no `--` separator in _run), so a value like "--upload-pack=<cmd>" would be
# option-injection / RCE on the host. Restrict to a conservative git-refname
# subset: no leading dash, and only word chars plus ./-/_ (covers "main",
# "release/1.2", "feature-x"; rejects options, spaces, and shell metacharacters).
_REF_RE = re.compile(r"^[A-Za-z0-9_][\w./-]*$")


def _safe_ref(branch: str) -> str:
    if not isinstance(branch, str) or not _REF_RE.match(branch):
        raise GitError(f"invalid branch name: {branch!r}", "unknown")
    return branch


# A git object id fed as a positional refspec (fetch <url> <oid>) needs the same
# no-leading-dash guard as a branch. The API schema already validates it, but the
# service is also called with anchors read back from the DB — validate here too
# so a bad value can never reach argv regardless of the caller.
_OID_RE = re.compile(r"^[0-9a-f]{7,64}$")


def _safe_oid(oid: str) -> str:
    if not isinstance(oid, str) or not _OID_RE.match(oid):
        raise GitError(f"invalid git object id: {oid!r}", "unknown")
    return oid


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
    """Parse `git status --porcelain -z` into [{path, changeType, size}] against
    HEAD+worktree. `size` is the working-tree byte size (0 for deletions), used
    by the UI to decide LFS tracking.

    The `-z` (NUL-delimited) format is mandatory here: plain `--porcelain` wraps
    paths containing spaces/UTF-8 in double quotes with C-style escapes (e.g.
    `"datasets/table agregee vf/_data.json"`), and those quotes would leak into
    the path we hand back to the client and later to `git rm`, so a deletion of a
    spaced path could never be staged. `-z` emits raw, unquoted bytes and uses a
    trailing NUL field for the rename/copy source, which we consume and drop."""
    out = _run(repo, "status", "--porcelain", "-z")
    records = out.split("\0")
    files: list[dict] = []
    i = 0
    while i < len(records):
        entry = records[i]
        i += 1
        if not entry:
            continue
        code = entry[:2].strip() or entry[:2]
        path = entry[3:]
        # A rename/copy carries its source path in the FOLLOWING NUL field; skip it.
        if code and code[0] in ("R", "C"):
            i += 1
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
    _safe_ref(branch)

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


async def sync_state(
    repo_getter,
    uid: str,
    branch: str,
    remote_url: str | None,
    synced_oid: str | None,
    token: str | None = None,
) -> dict:
    """Report where the entity stands vs the remote branch, given the DB anchor
    `synced_oid` (last commit we know we were in sync with; None if never).

    Cheap by design: it only fetches the remote ref and compares oids via
    merge-base — it does NOT need the local export (no ZIP upload, no unpack), so
    the client can call it without rebuilding the potentially-heavy export tree.
    Detecting whether the local content differs (ahead / dirty) is the status
    endpoint's job; here we only answer "did the remote move past our anchor?".

    Returns, in git terms only:
      remote_head : oid of origin/<branch>, or None if the branch/remote is absent
      synced_oid  : the anchor passed in (echoed for the response)
      behind      : remote moved past our anchor (anchor is an ancestor of remote_head)
      diverged    : anchor is set but is NOT an ancestor of remote_head (history was
                    rewritten/force-pushed, or the anchor is stale) — treat as "needs
                    attention on pull" like behind, distinct wording.

    The anchor is initialised at import time (set-sync-state) and moved on push, so
    an unanchored+existing-remote case here just means "no baseline yet" → neither
    behind nor diverged until the first push/import anchors it.
    """
    _safe_ref(branch)
    if synced_oid is not None:
        _safe_oid(synced_oid)

    def work() -> dict:
        repo = repo_getter(uid)
        _ensure_repo(repo, remote_url)
        if not remote_url:
            return {"remoteHead": None, "syncedOid": synced_oid, "behind": False, "diverged": False}
        _reject_internal_host(remote_url)
        ls_url = _with_credentials(remote_url, token)
        # A single ls-remote gives the remote head without fetching any objects —
        # far cheaper than _sync_remote_branch (no fetch, no LFS, no working tree).
        out = _run(repo, "ls-remote", "--heads", ls_url, branch, token=token, check=False)
        remote_head = None
        for line in out.splitlines():
            if f"refs/heads/{branch}" in line:
                remote_head = line.split()[0].strip()
                break
        if not remote_head:
            return {"remoteHead": None, "syncedOid": synced_oid, "behind": False, "diverged": False}

        behind = diverged = False
        if synced_oid and synced_oid != remote_head:
            # The remote moved off our anchor → at least "behind". To tell a clean
            # fast-forward (behind) from a rewrite (diverged) we need both commits
            # locally and a merge-base test. Fetch the tip's history (no --depth, so
            # the shared ancestor is reachable) and the anchor object; skip LFS blobs.
            skip_lfs = {"GIT_LFS_SKIP_SMUDGE": "1"}
            _run(repo, "fetch", "-q", ls_url, remote_head, token=token, env_extra=skip_lfs, check=False)
            _run(repo, "fetch", "-q", ls_url, synced_oid, token=token, env_extra=skip_lfs, check=False)
            anc = subprocess.run(
                ["git", "-C", str(repo), "merge-base", "--is-ancestor", synced_oid, remote_head],
                capture_output=True, timeout=_GIT_TIMEOUT, env=_git_env(),
            )
            # exit 0 → anchor is an ancestor of remote_head (clean fast-forward = behind).
            # exit 1 → not an ancestor (diverged/rewritten). Any other code (anchor
            # object still missing) → can't prove ancestry; report the less alarming
            # "behind" rather than "diverged".
            diverged = anc.returncode == 1
            behind = not diverged

        return {"remoteHead": remote_head, "syncedOid": synced_oid, "behind": behind, "diverged": diverged}

    async with _lock_for(repo_getter(uid)):
        return await asyncio.to_thread(work)


async def pull_file_bytes(
    repo_getter,
    uid: str,
    branch: str,
    path: str,
    remote_url: str | None,
    token: str | None = None,
) -> bytes:
    """Return the raw bytes of a managed file at the remote head, LFS resolved.

    Used by the pull's whole-list families (source-concepts.csv, scores parquet)
    where the block choice is "take the remote version": the client needs the
    actual content to write into the DB, which the (stats-only) preview omits.
    """
    _safe_ref(branch)

    def work() -> bytes:
        repo = repo_getter(uid)
        _safe_join(repo, path)  # reject a traversing path before any git use
        _ensure_repo(repo, remote_url)
        if not remote_url:
            raise GitError("mapping project is not linked to a git remote", "unknown")
        has_remote = _sync_remote_branch(repo, branch, remote_url, token)
        if not has_remote:
            raise GitError("remote branch not found", "not_found")
        remote_head = _run(repo, "rev-parse", "FETCH_HEAD", check=False).strip()
        # Materialise the file from the fetched commit, then resolve LFS if it's a
        # pointer (the fetch skipped smudge). We check out just this path.
        _run(repo, "checkout", remote_head, "--", path, check=False)
        target = _safe_join(repo, path)
        if not target.is_file():
            raise GitError(f"file not found at remote head: {path}", "not_found")
        data = target.read_bytes()
        if data[:40].startswith(b"version https://git-lfs") and _has_git_lfs():
            # The pointer needs smudging. `lfs pull` fetches via the origin remote,
            # which _ensure_repo set WITHOUT credentials — point it at the tokenized
            # URL for the pull, then restore the clean URL (mirrors clone_to_zip).
            ls_url = _with_credentials(remote_url, token)
            _run(repo, "lfs", "install", "--local", check=False)
            _run(repo, "remote", "set-url", "origin", ls_url, check=False)
            try:
                subprocess.run(
                    ["git", "-C", str(repo), "lfs", "pull", "--include", path],
                    capture_output=True, text=True, timeout=_GIT_TIMEOUT, env=_git_env(),
                )
            finally:
                _run(repo, "remote", "set-url", "origin", remote_url, check=False)
            data = target.read_bytes()
        return data

    async with _lock_for(repo_getter(uid)):
        return await asyncio.to_thread(work)


# Files a mapping-project pull merges as JSON (small — full content is returned).
_PULL_TEXT_FILES = ("mappings.json", "project.json")
# Whole-list families: too big to ship for a 3-way, so we return stats only; the
# actual bytes are pulled on resolution. (line count for CSV; presence for parquet.)
_PULL_STAT_FILES = ("source-concepts.csv", "similarity-scores.parquet")


def _blob_at(repo: Path, commit: str, path: str) -> str | None:
    """Text content of `path` at `commit`, or None if the file is absent there.
    An unresolved LFS pointer is returned as-is (the caller decides)."""
    out = _run(repo, "show", f"{commit}:{path}", check=False)
    return out if out else None


def _csv_line_count(text: str) -> int:
    """Data-row count of a CSV (excludes the header, ignores a trailing newline)."""
    n = text.count("\n")
    if text and not text.endswith("\n"):
        n += 1
    return max(0, n - 1)  # minus the header row


async def pull_preview(
    repo_getter,
    uid: str,
    branch: str,
    remote_url: str | None,
    synced_oid: str | None,
    token: str | None = None,
) -> dict:
    """Fetch BASE (synced_oid) and REMOTE (remote head), returning the managed
    files' content for the client to 3-way merge against its own DB (LOCAL).

    JSON families (mappings/project) come back as full text; heavy whole-list
    families (source CSV, scores parquet) come back as stats only — their bytes
    are fetched on resolution, not for the preview. LOCAL is NOT read here: the
    client already has it in the database.
    """
    _safe_ref(branch)
    if synced_oid is not None:
        _safe_oid(synced_oid)

    def work() -> dict:
        repo = repo_getter(uid)
        _ensure_repo(repo, remote_url)
        if not remote_url:
            raise GitError("mapping project is not linked to a git remote", "unknown")
        # Fetch both commits' trees + LFS for the CSV line count. This is the one
        # place we DO want file contents (unlike sync_state), so smudge LFS.
        has_remote = _sync_remote_branch(repo, branch, remote_url, token)
        if not has_remote:
            raise GitError("remote branch not found", "not_found")
        remote_head = _run(repo, "rev-parse", "FETCH_HEAD", check=False).strip()
        ls_url = _with_credentials(remote_url, token)
        if synced_oid:
            _run(repo, "fetch", "-q", ls_url, synced_oid, token=token,
                 env_extra={"GIT_LFS_SKIP_SMUDGE": "1"}, check=False)

        def side(commit: str | None) -> dict:
            if not commit:
                return {"files": {}, "stats": {}}
            files: dict[str, str | None] = {}
            for name in _PULL_TEXT_FILES:
                files[name] = _blob_at(repo, commit, name)
            stats: dict[str, dict] = {}
            for name in _PULL_STAT_FILES:
                # The git blob oid uniquely fingerprints the file's content at this
                # commit (for an LFS file, the blob IS the pointer, whose oid changes
                # iff the tracked content changes). Comparing base↔remote oids tells
                # us "did the remote change this file" WITHOUT smudging the LFS blob —
                # a row count would need the real content (expensive, and impossible
                # here since we skip smudge). So oid is the reliable "changed" signal.
                oid = _run(repo, "rev-parse", f"{commit}:{name}", check=False).strip() or None
                if oid is None:
                    stats[name] = {"present": False}
                    continue
                raw = _blob_at(repo, commit, name)
                stat: dict = {"present": True, "oid": oid}
                if raw and raw.startswith("version https://git-lfs"):
                    stat["lfs"] = True
                    for line in raw.splitlines():
                        if line.startswith("size "):
                            stat["byteSize"] = int(line.split(" ", 1)[1] or 0)
                elif raw is not None:
                    stat["byteSize"] = len(raw.encode("utf-8", "ignore"))
                    if name.endswith(".csv"):
                        stat["rowCount"] = _csv_line_count(raw)  # only when not LFS
                stats[name] = stat
            return {"files": files, "stats": stats}

        return {
            "branch": branch,
            "remoteHead": remote_head,
            "syncedOid": synced_oid,
            "base": side(synced_oid),
            "remote": side(remote_head),
        }

    async with _lock_for(repo_getter(uid)):
        return await asyncio.to_thread(work)


# Shipping megabytes to the browser (and diffing them, LCS is O(n²)) would freeze
# the UI, so an oversized text file is truncated to a preview rather than dropped:
# the user still sees the head of a big CSV/JSON instead of "too large".
_DIFF_MAX_BYTES = 256 * 1024
_DIFF_MAX_LINES = 1000
# For an oversized *modified* file we don't truncate by position (that hides any
# change past line 1000); instead we condense to just the changed blocks + a few
# context lines — the first _DIFF_MAX_HUNKS of them — like GitHub's big-file view.
_DIFF_HUNK_CONTEXT = 3
_DIFF_MAX_HUNKS = 1000
# difflib is ~O(n·m); on a huge file where most lines differ it can take minutes.
# Above this line count on either side we don't attempt a hunk diff and fall back
# to the head preview, keeping the request responsive.
_DIFF_HUNK_MAX_LINES = 200_000


def _normalize_eol(text: str) -> str:
    """Collapse CRLF/CR to LF so a file that only changed line endings doesn't show
    as modified (and doesn't blow up difflib into its O(n²) worst case, where every
    line differs by a trailing \\r). Line-ending style is not a meaningful diff for
    the text files we version."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


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


def _condense_hunks(old_text: str, new_text: str) -> tuple[str, str, bool]:
    """Condense a large file's diff to just the changed blocks + context, so the
    viewer shows every real change (even past line 1000) instead of a positional
    head-of-file preview. Returns (old_condensed, new_condensed, truncated), where
    each side is the changed regions joined by "@@ …" markers; truncated is True
    when more than _DIFF_MAX_HUNKS change groups were dropped.

    Both sides share the same marker lines, so Monaco renders them as identical
    context and only the real +/- lines get highlighted."""
    old_lines = old_text.split("\n")
    new_lines = new_text.split("\n")
    ctx = _DIFF_HUNK_CONTEXT
    opcodes = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False).get_opcodes()

    # Group each change with its surrounding context, merging groups whose context
    # windows touch, so adjacent edits read as one block rather than many tiny ones.
    ranges: list[tuple[int, int, int, int]] = []  # (o1, o2, n1, n2) inclusive-exclusive
    for tag, o1, o2, n1, n2 in opcodes:
        if tag == "equal":
            continue
        lo_o, hi_o = max(0, o1 - ctx), min(len(old_lines), o2 + ctx)
        lo_n, hi_n = max(0, n1 - ctx), min(len(new_lines), n2 + ctx)
        if ranges and lo_o <= ranges[-1][1] and lo_n <= ranges[-1][3]:
            po1, _, pn1, _ = ranges[-1]
            ranges[-1] = (po1, hi_o, pn1, hi_n)
        else:
            ranges.append((lo_o, hi_o, lo_n, hi_n))

    truncated = len(ranges) > _DIFF_MAX_HUNKS
    ranges = ranges[:_DIFF_MAX_HUNKS]

    old_out: list[str] = []
    new_out: list[str] = []
    for o1, o2, n1, n2 in ranges:
        marker = f"@@ -{o1 + 1},{o2 - o1} +{n1 + 1},{n2 - n1} @@"
        old_out.append(marker)
        new_out.append(marker)
        old_out.extend(old_lines[o1:o2])
        new_out.extend(new_lines[n1:n2])
    return "\n".join(old_out), "\n".join(new_out), truncated


async def diff(repo_getter, uid: str, zip_bytes: bytes, branch: str, path: str, remote_url: str | None, token: str | None = None) -> dict:
    """Old (remote HEAD) vs new (export) content for one file in the export tree.

    Oversized/binary files return no content (too_large/binary flags) so the
    viewer never tries to render a multi-megabyte or non-text diff."""
    _safe_ref(branch)

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
        # Byte-identical already? Then git flags "modified" for a reason unrelated to
        # content — most often a storage-mode switch, e.g. a file committed as plain
        # text that .gitattributes now routes through the Git LFS clean filter (HEAD
        # blob = text, working tree = LFS pointer). Distinguish that from a pure
        # line-ending change so the viewer can explain the right thing.
        content_identical = old_raw == new_raw and not old_is_lfs
        # Compare content, not line-ending style: normalize before diffing so an
        # export that rewrote CRLF→LF (or vice-versa) doesn't read as "modified"
        # (and doesn't push difflib into its O(n²) every-line-differs worst case).
        old_raw = _normalize_eol(old_raw)
        new_raw = _normalize_eol(new_raw)
        old, old_trunc, old_bin = _diff_payload(old_raw)
        new, new_trunc, new_bin = _diff_payload(new_raw)
        old_bin = old_bin or old_is_lfs
        binary = old_bin or new_bin
        change_type = status_files.get(path, "modified")
        oversized = old_trunc or new_trunc

        def result(content_old: str, content_new: str, mode: str, trunc: bool) -> dict:
            return {
                "path": path,
                "changeType": change_type,
                "oldContent": content_old,
                "newContent": content_new,
                "truncated": trunc,
                "truncationMode": mode,
                "binary": binary,
            }

        # Git flags "modified" but the content is unchanged — show a plain notice
        # instead of an empty diff. Two sub-cases, distinguished for a clearer
        # message: identical bytes (storage-mode switch, e.g. text→LFS) vs identical
        # only after normalizing line endings (CRLF↔LF). Done before difflib, which
        # is slow on huge inputs even when they're identical.
        if not binary and old_raw == new_raw:
            return result("", "", "no_content_change" if content_identical else "eol_only", False)

        # Oversized text file modified in place: condense to just the changed blocks
        # so every real change is visible (not only the head). Skip for binary/LFS,
        # pure add/delete (nothing to compare), or files so large difflib would hang
        # — those fall back to the head preview below.
        both_sides = bool(old_raw) and bool(new_raw)
        within_hunk_budget = (
            old_raw.count("\n") < _DIFF_HUNK_MAX_LINES and new_raw.count("\n") < _DIFF_HUNK_MAX_LINES
        )
        if not binary and oversized and both_sides and within_hunk_budget:
            old_h, new_h, hunk_trunc = _condense_hunks(old_raw, new_raw)
            return result(old_h, new_h, "hunks", hunk_trunc)

        return result(old, new, "head" if oversized else "none", oversized)

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
    synced_oid: str | None = None,
) -> dict:
    """Unpack the export and commit the selected files (all if paths is None) on
    top of the fetched remote branch, then push. Push-only flow.

    Guard against clobbering un-pulled remote work: the commit is built on top of
    the fetched remote head from the LOCAL export, which does NOT contain whatever
    the remote gained since our anchor (synced_oid). Pushing that would fast-forward
    the remote and silently drop those changes. So if the remote moved past our
    anchor, refuse with a `pull_required` GitError — the user must pull first.
    """
    _safe_ref(branch)
    if synced_oid is not None:
        _safe_oid(synced_oid)

    def work() -> dict:
        repo = repo_getter(uid)
        _ensure_repo(repo, remote_url)
        has_remote = _sync_remote_branch(repo, branch, remote_url, token)
        # Refuse to push over un-pulled remote changes (see docstring). Any move of
        # the remote head off our anchor — fast-forward or diverged — means the local
        # export lacks remote content, so pushing would drop it. Only guard when we
        # have an anchor; a first push (no anchor / no remote branch) is allowed.
        if has_remote and synced_oid:
            remote_head = _run(repo, "rev-parse", "FETCH_HEAD", check=False).strip()
            if remote_head and remote_head != synced_oid:
                raise GitError("remote has changes you don't have; pull first", "pull_required")
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


async def clone_to_zip(url: str, branch: str, token: str | None) -> tuple[bytes, str | None]:
    """Shallow-clone a remote into a temp dir and return (zip_bytes, cloned_oid).

    Used by the import flow in server mode (replaces the in-browser
    isomorphic-git clone, so no CORS proxy is needed). The .git dir is excluded
    — the caller treats the result as an importable export tree. `cloned_oid` is
    the HEAD commit of the clone, so the caller can anchor the new entity's
    git_sync_state to it (it IS the base we imported from → later pushes to the
    same remote are detected as "behind" against this anchor).
    """
    if branch:
        _safe_ref(branch)

    def work() -> tuple[bytes, str | None]:
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
            # Resolve Git LFS pointers to their real content. _git_env() isolates git
            # from the host config (HOME=/nonexistent, GIT_CONFIG_NOSYSTEM), so the
            # LFS smudge filter never ran during clone — a tracked file (e.g. a large
            # source-concepts.csv) would otherwise land in the ZIP as a 3-line pointer
            # and import as an empty source. Install the filter locally and pull the
            # blobs, reusing the tokenized origin URL for the private LFS endpoint.
            # Best-effort: a partial LFS failure must not lose the rest of the tree.
            if _has_git_lfs() and (repo / ".gitattributes").is_file():
                _run(repo, "lfs", "install", "--local", check=False)
                lfs = subprocess.run(
                    ["git", "-C", str(repo), "lfs", "pull"],
                    capture_output=True, text=True, timeout=_GIT_TIMEOUT, env=_git_env(),
                )
                if lfs.returncode != 0:
                    logger.warning("git lfs pull failed during clone (%s); large files may remain pointers",
                                   _scrub(lfs.stderr.strip(), token))
            cloned_oid = _run(repo, "rev-parse", "HEAD", check=False).strip() or None
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for p in repo.rglob("*"):
                    if ".git" in p.relative_to(repo).parts:
                        continue
                    if p.is_file():
                        zf.write(p, p.relative_to(repo).as_posix())
            return buf.getvalue(), cloned_oid
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
