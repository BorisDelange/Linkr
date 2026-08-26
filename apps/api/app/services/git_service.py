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
import csv
import difflib
import io
import ipaddress
import re
import shutil
import socket
import subprocess
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import structlog

from app.config import settings
from app.services.export_layout import ENTITY_MANIFEST

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


def remove_repo(kind: str, entity_id: str) -> None:
    """Delete an entity's on-disk versioning working tree (the whole
    data_path/<kind>/<id>/ dir, git repo included). Called when the entity is
    deleted so its versioning folder doesn't linger as an orphan. `kind` is the
    same folder segment the *_repo helpers use ("workspaces", "mapping-projects",
    "sql-collections", …). No-op if the dir is absent (never versioned)."""
    # entity_id comes from trusted DB callers today, but this is an rmtree — guard
    # against an id that resolves outside data_path/<kind> (defense in depth).
    target = _safe_join(settings.data_path / kind, entity_id)
    shutil.rmtree(target, ignore_errors=True)


def rename_repo(kind: str, old_id: str, new_id: str) -> bool:
    """Rename an entity's on-disk versioning tree when its key changes.

    Used by the schema-preset key move (preset_id → id): the repo path embeds
    the key, so a preset whose key changed would otherwise keep a working tree
    under a name nothing points at any more.

    Idempotent and defensive on purpose — it runs at startup, possibly against a
    tree that a previous run already moved:
      - same name → nothing to do
      - source absent → nothing to do (never versioned, or already renamed)
      - destination already there → leave both alone and report it, rather than
        clobber a tree that may hold unpushed commits

    Returns True when a directory was actually moved.
    """
    if old_id == new_id:
        return False
    base = settings.data_path / kind
    src = _safe_join(base, old_id)
    dst = _safe_join(base, new_id)
    if not src.is_dir():
        return False
    if dst.exists():
        logger.warning(
            "not renaming %s/%s → %s: destination already exists", kind, old_id, new_id
        )
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return True


_GH_NAV_SEGMENTS = ("tree", "blob", "commit", "commits", "pull", "pulls", "releases", "tags", "branches", "find", "raw")


def _clean_url(url: str) -> str:
    """Strip browser-navigation cruft from a pasted repo URL (defense in depth;
    the frontend cleans too). A schemeless host/path (`gitlab.com/g/repo`) gets an
    `https://` prefix. GitLab uses a `/-/` separator; GitHub uses known path
    segments. Query/fragment are dropped. SSH URLs are left untouched."""
    url = (url or "").strip()
    # Infer https:// for a schemeless host/path, but leave SSH-style (git@host:…)
    # and anything already carrying a scheme alone. Only when the first segment
    # looks like a domain, so a bare local path isn't taken for a remote.
    if url and not re.match(r"[a-z][a-z0-9+.-]*://", url, re.I) and not re.match(r"[\w.-]+@[^/]+:", url):
        host = url.split("/", 1)[0]
        if "." in host:
            url = "https://" + url
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
    # ls-remote with check=True so an AUTH failure (private repo, no/invalid token)
    # is surfaced as a GitError instead of being mistaken for an empty remote — the
    # latter would make every file show as "added" (looks like the repo is empty)
    # and silently hide that a token is required. A genuinely new/empty remote
    # succeeds here with no matching ref, which we still treat as "first push".
    out = _run(repo, "ls-remote", "--heads", fetch_url, branch, token=token)
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
    but tracked in HEAD).

    A renamed path carries its old name with it. Git reports a rename as ONE
    entry under the new path (`R entity.json`, old name in a trailing field), so
    the status list has no row for the old one and the caller cannot select it.
    Staging the new path alone committed the addition and left the deletion
    behind, so the old file survived on the remote — then read back as an
    incoming deletion, the "changes to pull" that never cleared. The manifest
    rename (project.json -> entity.json) hit this on every entity at once.
    """
    renames = _rename_sources(repo)
    for rel in paths:
        if _safe_join(repo, rel).is_file():
            _run(repo, "add", "--", rel)
            old = renames.get(rel)
            # `git rm --cached` would untrack it without recording a deletion;
            # the file is already gone from the working tree, so plain `rm` is
            # what stages the removal.
            if old:
                _run(repo, "rm", "-q", "--", old, check=False)
        else:
            _run(repo, "rm", "-q", "--", rel, check=False)


def _rename_sources(repo: Path) -> dict[str, str]:
    """new path → the path it was renamed FROM, per git's own rename detection.

    Uses git's own pairing rather than a second opinion: it is a similarity
    heuristic, so recomputing it here could disagree with the status list the
    user actually acted on.

    Detection needs BOTH sides in the index — with an untracked new file and an
    unstaged deletion git reports `?? new` + ` D old` and no pair at all. The
    selective-staging path deliberately leaves the index clean, so this stages
    everything into a THROWAWAY index (`GIT_INDEX_FILE`) purely to ask the
    question, leaving the real one untouched for the caller to fill in.
    """
    with tempfile.TemporaryDirectory() as tmp:
        probe_index = Path(tmp) / "index"
        env = {"GIT_INDEX_FILE": str(probe_index)}
        # Seed from HEAD so the probe compares against the committed tree, then
        # add the working tree on top: that is what pairs a removal with its
        # replacement.
        _run(repo, "read-tree", "HEAD", check=False, env_extra=env)
        _run(repo, "add", "-A", check=False, env_extra=env)
        out = _run(repo, "status", "--porcelain", "-z", check=False, env_extra=env)
    records = out.split("\0")
    sources: dict[str, str] = {}
    i = 0
    while i < len(records):
        entry = records[i]
        i += 1
        if not entry:
            continue
        code = entry[:2].strip() or entry[:2]
        if code and code[0] in ("R", "C"):
            source = records[i] if i < len(records) else None
            i += 1
            # A copy keeps its source; only a rename removes it.
            if code[0] == "R" and source:
                sources[entry[3:]] = source
    return sources


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
    """Parse `git status --porcelain -z` into [{path, changeType, size, oldPath}]
    against HEAD+worktree. `size` is the working-tree byte size (0 for deletions),
    used by the UI to decide LFS tracking.

    The `-z` (NUL-delimited) format is mandatory here: plain `--porcelain` wraps
    paths containing spaces/UTF-8 in double quotes with C-style escapes (e.g.
    `"datasets/table agregee vf/_data.json"`), and those quotes would leak into
    the path we hand back to the client and later to `git rm`, so a deletion of a
    spaced path could never be staged. `-z` emits raw, unquoted bytes and uses a
    trailing NUL field for the rename/copy source.

    `oldPath` (that source field) is carried through rather than dropped: a
    rename is reported under its NEW path, so a diff that looked HEAD up by that
    path alone would find nothing at HEAD and render the whole file as added —
    an empty left pane. A rename whose content also changed (git pairs the two up
    to a similarity threshold, so `R` does NOT mean "identical") is exactly the
    case that needs the old path to show a real before/after.
    """
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
        old_path = None
        # A rename/copy carries its source path in the FOLLOWING NUL field.
        if code and code[0] in ("R", "C"):
            old_path = records[i] if i < len(records) else None
            i += 1
        fp = repo / path
        size = fp.stat().st_size if fp.is_file() else 0
        record = {
            "path": path,
            "changeType": _STATUS_CODE.get(code, "modified"),
            "size": size,
        }
        if old_path:
            record["oldPath"] = old_path
        files.append(record)
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
    reviewed_oid: str | None = None,
) -> dict:
    """Report where the entity stands vs the remote branch, given the DB cursors.

    `synced_oid` is the content anchor (last commit whose content we hold);
    `reviewed_oid` is the decision cursor (last commit every item of which got an
    explicit decision). **behind/diverged are computed against the decision
    cursor**, falling back to the anchor when it is unset — a partial pull that
    was fully deliberated must clear the banner and unblock the push even though
    the content anchor deliberately stayed behind (see models/git_sync_state.py).

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
    if reviewed_oid is not None:
        _safe_oid(reviewed_oid)
    # What "up to date" is measured against: the user's last complete deliberation
    # if there is one, else the content anchor.
    cursor = reviewed_oid or synced_oid

    def work() -> dict:
        repo = repo_getter(uid)
        _ensure_repo(repo, remote_url)
        base = {
            "syncedOid": synced_oid,
            "reviewedOid": reviewed_oid,
            "behind": False,
            "diverged": False,
        }
        if not remote_url:
            return {"remoteHead": None, **base}
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
            return {"remoteHead": None, **base}

        # The anchor is ONLY ever what a pull/import recorded (`set-sync-state`).
        #
        # It used to be backfilled from the scratch repo's `rev-parse HEAD` when
        # the DB had no row, on the reasoning "we were here, the remote moved on".
        # That reasoning does not hold here: this repo is a shared scratch area
        # that `_sync_remote_branch` resets to FETCH_HEAD on every status/diff/push,
        # so its HEAD tracks the REMOTE, never the content applied to the database.
        # A status call landing before sync_state (both run from the same mount and
        # serialize on the same repo lock) left HEAD == remote_head, the adoption
        # fired, and the anchor was persisted — clearing the behind banner and
        # disarming the pull-first push guard for content that was never imported,
        # permanently. An entity with no anchor stays unanchored: reporting nothing
        # is honest, claiming a sync that never happened is not.
        anchor = cursor

        behind = diverged = False
        if anchor and anchor != remote_head:
            # The remote moved off our anchor → at least "behind". To tell a clean
            # fast-forward (behind) from a rewrite (diverged) we need both commits
            # locally and a merge-base test. Fetch the tip's history (no --depth, so
            # the shared ancestor is reachable) and the anchor object; skip LFS blobs.
            skip_lfs = {"GIT_LFS_SKIP_SMUDGE": "1"}
            _run(repo, "fetch", "-q", ls_url, remote_head, token=token, env_extra=skip_lfs, check=False)
            _run(repo, "fetch", "-q", ls_url, anchor, token=token, env_extra=skip_lfs, check=False)
            anc = subprocess.run(
                ["git", "-C", str(repo), "merge-base", "--is-ancestor", anchor, remote_head],
                capture_output=True, timeout=_GIT_TIMEOUT, env=_git_env(),
            )
            # exit 0 → anchor is an ancestor of remote_head (clean fast-forward = behind).
            # exit 1 → not an ancestor (diverged/rewritten). Any other code (anchor
            # object still missing) → can't prove ancestry; report the less alarming
            # "behind" rather than "diverged".
            diverged = anc.returncode == 1
            behind = not diverged

        return {
            "remoteHead": remote_head,
            "syncedOid": synced_oid,
            "reviewedOid": reviewed_oid,
            "behind": behind,
            "diverged": diverged,
        }

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
        data = _materialize_at(repo, remote_head, path, remote_url, token)
        if data is None:
            raise GitError(f"file not found at remote head: {path}", "not_found")
        return data

    async with _lock_for(repo_getter(uid)):
        return await asyncio.to_thread(work)


def _materialize_at(
    repo: Path, commit: str, path: str, remote_url: str, token: str | None
) -> bytes | None:
    """Check `path` out of `commit` and return its real bytes, LFS resolved.

    `git show <commit>:<path>` is NOT enough for an LFS-tracked file: it returns
    the 3-line pointer, since our fetches deliberately skip the smudge filter. Any
    caller that needs the actual content (and not just a content fingerprint) must
    go through here, or it silently gets the pointer text instead of the file.
    """
    _safe_join(repo, path)  # reject a traversing path before any git use
    _run(repo, "checkout", commit, "--", path, check=False)
    target = _safe_join(repo, path)
    if not target.is_file():
        return None
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


# Files a mapping-project pull merges as JSON (small — full content is returned).
#
# source-concept-ids/ rides along because the badge registry was pushed but never
# pulled: two instances allocating ids in parallel diverged silently, and those ids
# end up in generated OMOP concepts. Its merge is monotone (keep the local id on a
# collision, nextId = max), so it needs no user choice — it is applied on every
# pull like a CRDT counter.
_PULL_TEXT_FILES = (
    "mappings.json",
    ENTITY_MANIFEST,
    # A repo published before the manifest rename still carries project.json; the
    # tolerant readers accept either, so the pull must fetch either.
    "project.json",
    "source-concept-ids/entries.json",
    "source-concept-ids/ranges.json",
)

# Docs the entity owns as fields (readme / license) rather than as tree content.
# Enumerated from the commit instead of hardcoded, because the README has one file
# per language (README.md + README.<lang>.md, see writeReadmeFiles) and a fixed
# tuple would silently drop every translation.
# Twin of README_FILE_RE in apps/web/src/lib/entity-tree.ts — keep the language
# shape in sync (bare `fr` or regional `pt-BR`). They diverged once, and the
# narrower half silently dropped regional translations.
_DOCS_RE = re.compile(
    r"^(README(\.[a-z]{2,3}(-[A-Za-z]{2,4})?)?|LICENSE)\.md$", re.IGNORECASE
)


def _docs_files_at(repo: Path, commit: str) -> list[str]:
    """Root-level README/LICENSE paths present at `commit`."""
    out = _run(repo, "ls-tree", "--name-only", commit, check=False)
    return [line.strip() for line in out.splitlines() if _DOCS_RE.match(line.strip())]
# Whole-list families: too big to ship for a 3-way, so we return stats only; the
# actual bytes are pulled on resolution. (line count for CSV.)
#
# similarity-scores.parquet is NOT here: scores are gitignored (re-derivable, and
# ~100 MB), so they are never in a repo — offering them left the pull proposing a
# file that could not exist, with an unknowable "?" row count.
_PULL_STAT_FILES = ("source-concepts.csv",)


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


# Column names the source-concepts CSV may use for the identity pair. Twin of
# VOCAB_COLUMNS/CODE_COLUMNS in apps/web/src/lib/concept-mapping/source-concepts-diff.ts.
_VOCAB_COLUMNS = ("vocabulary_id", "terminology", "terminology_name")
_CODE_COLUMNS = ("concept_code", "code")
_NAME_COLUMNS = ("concept_name", "name", "label")

# The review dialog lists the rows that moved; a full 60 000-row list would be
# pointless to scroll and expensive to ship, so we cap it and tell the client the
# list was truncated (the COUNTS above stay exact — only the listing is capped).
_MAX_LISTED_CONCEPT_CHANGES = 2000


def _key_source_concepts_named(
    text: str | None,
    column_mapping: dict | None = None,
) -> tuple[dict[str, str], dict[str, str]] | None:
    """Like `_key_source_concepts`, plus a `{key: concept_name}` map for the UI.

    The name is what makes a review meaningful — "5 concepts disappear" is only
    actionable if the user can see WHICH ones.

    `column_mapping` is the project's own `fileSourceData.columnMapping`, which
    NAMES the identity columns. It takes priority over the guessed names: a source
    CSV is the user's file, so its headers are whatever they were on import
    (`terminology_code`, …) and guessing from a fixed list mis-declared real files
    as "not comparable". The guesses remain as the fallback for a project whose
    mapping is absent or stale.
    """
    if not text or text.startswith("version https://git-lfs"):
        return None
    reader = csv.reader(io.StringIO(text))
    try:
        headers = next(reader)
    except StopIteration:
        return None
    except csv.Error:
        # Not actually delimited text: some sites export source-concepts.csv as
        # Parquet under the .csv name, and its bytes decode into stray newlines
        # the csv module rejects. Unkeyable, like an LFS pointer — not a crash.
        return None
    lower = [h.strip().lower() for h in headers]

    def find(names: tuple[str, ...], mapped: str | None = None) -> int:
        # The project's declared column wins when the CSV actually carries it.
        if mapped and mapped.strip().lower() in lower:
            return lower.index(mapped.strip().lower())
        for name in names:
            if name in lower:
                return lower.index(name)
        return -1

    mapping = column_mapping or {}
    vocab_idx = find(_VOCAB_COLUMNS, mapping.get("terminologyColumn"))
    code_idx = find(_CODE_COLUMNS, mapping.get("conceptCodeColumn"))
    if vocab_idx < 0 or code_idx < 0:
        return None
    name_idx = find(_NAME_COLUMNS, mapping.get("conceptNameColumn"))

    rows: dict[str, str] = {}
    names: dict[str, str] = {}
    # A (vocabulary, code) pair is NOT unique in a real source file: MIMIC ships
    # "Acetaminophen" and "Acetaminophen " (trailing space) as separate concepts,
    # 345 such pairs in the RiCDC export alone. Keying on the pair alone collapsed
    # them silently, under-counting the diff. A repeat gets an occurrence suffix so
    # every physical row keeps its own identity. Twin of source-concepts-diff.ts.
    seen: dict[str, int] = {}
    try:
        rows_iter = list(reader)
    except csv.Error:
        # csv parses lazily, so a binary payload can survive the header read and
        # blow up mid-iteration instead.
        return None
    for cells in rows_iter:
        if not cells:
            continue
        vocabulary = (cells[vocab_idx] if vocab_idx < len(cells) else "").strip()
        code = (cells[code_idx] if code_idx < len(cells) else "").strip()
        if not code:
            continue
        pair = f"{vocabulary}|{code}"
        n = seen.get(pair, 0)
        seen[pair] = n + 1
        key = pair if n == 0 else f"{pair}#{n}"
        rows[key] = "".join(
            c for i, c in enumerate(cells) if i not in (vocab_idx, code_idx)
        )
        if 0 <= name_idx < len(cells):
            names[key] = cells[name_idx].strip()
    return rows, names


def _key_source_concepts(text: str | None) -> dict[str, str] | None:
    """Map every row of a source-concepts CSV to ``{vocabulary|code: content}``.

    None when the file cannot be keyed (absent, an unsmudged LFS pointer, or a
    CSV without both identity columns) — the caller must then fall back to a
    whole-file choice instead of reporting a diff computed from nothing.

    Done server-side because both sides are already on disk here: shipping two
    ~5 MB CSVs to the browser just to count rows would cost more than the pull.
    """
    if not text or text.startswith("version https://git-lfs"):
        return None
    reader = csv.reader(io.StringIO(text))
    try:
        headers = next(reader)
    except (StopIteration, csv.Error):
        return None
    lower = [h.strip().lower() for h in headers]

    def find(names: tuple[str, ...]) -> int:
        for name in names:
            if name in lower:
                return lower.index(name)
        return -1

    vocab_idx = find(_VOCAB_COLUMNS)
    code_idx = find(_CODE_COLUMNS)
    if vocab_idx < 0 or code_idx < 0:
        return None

    rows: dict[str, str] = {}
    try:
        rows_iter = list(reader)
    except csv.Error:
        return None
    for cells in rows_iter:
        if not cells:
            continue
        vocabulary = (cells[vocab_idx] if vocab_idx < len(cells) else "").strip()
        code = (cells[code_idx] if code_idx < len(cells) else "").strip()
        # A row with no code has no identity — counting it would be pure churn.
        if not code:
            continue
        content = "".join(
            c for i, c in enumerate(cells) if i not in (vocab_idx, code_idx)
        )
        rows[f"{vocabulary}|{code}"] = content
    return rows


def _diff_source_concepts(
    local_csv: str | None,
    remote_csv: str | None,
    column_mapping: dict | None = None,
) -> dict[str, object]:
    """Added / removed / modified source concepts, keyed by (vocabulary, code).

    "The blob changed" is useless for a 60 000-row file — it reads the same
    whether two concepts were added or every one was replaced. This gives the
    pull UI the same +N/-M vocabulary the mappings merge already speaks.

    Both sides are keyed with the project's own `columnMapping`, so a user CSV
    keeps working whatever its headers are called.
    """
    local_keyed = _key_source_concepts_named(local_csv, column_mapping)
    remote_keyed = _key_source_concepts_named(remote_csv, column_mapping)
    if local_keyed is None or remote_keyed is None:
        return {
            "keyed": False,
            "added": 0,
            "removed": 0,
            "modified": 0,
            "unchanged": 0,
            "localTotal": len(local_keyed[0]) if local_keyed else 0,
            "remoteTotal": len(remote_keyed[0]) if remote_keyed else 0,
            "changes": [],
            "changesTruncated": False,
        }
    local, local_names = local_keyed
    remote, remote_names = remote_keyed

    added = modified = unchanged = 0
    changes: list[dict] = []

    def record(key: str, state: str, names: dict[str, str]) -> None:
        if len(changes) >= _MAX_LISTED_CONCEPT_CHANGES:
            return
        # Strip the occurrence suffix a duplicated pair carries (see the keying).
        base = key.rsplit("#", 1)[0] if "#" in key else key
        vocabulary, _, code = base.partition("|")
        changes.append(
            {
                "key": key,
                "state": state,
                "vocabulary": vocabulary,
                "code": code,
                "name": names.get(key, ""),
            }
        )

    for key, remote_content in remote.items():
        if key not in local:
            added += 1
            record(key, "add", remote_names)
        elif local[key] != remote_content:
            modified += 1
            record(key, "modify", remote_names)
        else:
            unchanged += 1
    removed = 0
    for key in local:
        if key not in remote:
            removed += 1
            # Names come from the LOCAL side here: the row is gone remotely, so
            # only we still know what it was called.
            record(key, "delete", local_names)

    return {
        "keyed": True,
        "added": added,
        "removed": removed,
        "modified": modified,
        "unchanged": unchanged,
        "localTotal": len(local),
        "remoteTotal": len(remote),
        "changes": changes,
        "changesTruncated": (added + removed + modified) > len(changes),
    }


async def pull_preview(
    repo_getter,
    uid: str,
    branch: str,
    remote_url: str | None,
    synced_oid: str | None,
    token: str | None = None,
    local_source_csv: bytes | None = None,
    source_column_mapping: dict | None = None,
) -> dict:
    """Fetch BASE (synced_oid) and REMOTE (remote head), returning the managed
    files' content for the client to 3-way merge against its own DB (LOCAL).

    JSON families (mappings/project) come back as full text; the heavy source CSV
    comes back as stats only — its bytes are fetched on resolution, not for the
    preview. LOCAL is NOT read here (the client has it in the database), with one
    exception: `local_source_csv` lets us diff the source concept list row by row
    server-side, where both sides already sit on disk.
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
            # README/LICENSE ride along as text: they are small, and the client
            # merges them like any other field the entity owns.
            for name in _docs_files_at(repo, commit):
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

        # Row-level source-concept diff: LOCAL (from the DB blob) vs REMOTE, so
        # the UI can say "+2 / -5 concepts" instead of "the file changed".
        #
        # Materialised, not `git show`: the CSV is routinely LFS-tracked (it is the
        # big file in a mapping-project repo), and `git show` hands back the 3-line
        # pointer, which cannot be keyed — the diff then reported "not comparable"
        # for exactly the repos that need it most.
        remote_csv_bytes = (
            _materialize_at(repo, remote_head, "source-concepts.csv", remote_url, token)
            if remote_head
            else None
        )
        remote_csv = (
            remote_csv_bytes.decode("utf-8", "replace") if remote_csv_bytes else None
        )
        source_concepts_diff = _diff_source_concepts(
            local_source_csv.decode("utf-8", "replace") if local_source_csv else None,
            remote_csv,
            source_column_mapping,
        )

        return {
            "branch": branch,
            "remoteHead": remote_head,
            "syncedOid": synced_oid,
            "base": side(synced_oid),
            "remote": side(remote_head),
            "sourceConceptsDiff": source_concepts_diff,
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
# to the head preview, keeping the request responsive. _condense_hunks trims the
# common prefix/suffix first, so a large-but-barely-changed file (the usual case
# for a generated mappings.json) costs almost nothing and this cap only bites when
# the content genuinely differs throughout.
_DIFF_HUNK_MAX_LINES = 200_000
# The cap above is on the RAW size, which the affix trim usually reduces to
# nothing — but only when the changes are clustered. Scattered edits (one changed
# line in each of ~1500 JSON objects) trim to almost the whole file and difflib
# then runs for minutes: measured 1.7s at 2k lines, 14s at 4k, 110s at 8k, i.e.
# quadratic. So cap the CORE that actually reaches difflib; past this we can't
# show a diff at all and the viewer offers a download instead.
_DIFF_HUNK_MAX_CORE_LINES = 3_000


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


def _condense_hunks(old_text: str, new_text: str) -> tuple[str, str, bool] | None:
    """Condense a large file's diff to just the changed blocks + context, so the
    viewer shows every real change (even past line 1000) instead of a positional
    head-of-file preview. Returns (old_condensed, new_condensed, truncated), where
    each side is the changed regions joined by "@@ …" markers; truncated is True
    when more than _DIFF_MAX_HUNKS change groups were dropped. Returns None when
    the changes are too scattered to diff in reasonable time (see
    _DIFF_HUNK_MAX_CORE_LINES) — the caller then reports the file as undiffable.

    Both sides share the same marker lines, so Monaco renders them as identical
    context and only the real +/- lines get highlighted."""
    old_lines = old_text.split("\n")
    new_lines = new_text.split("\n")
    ctx = _DIFF_HUNK_CONTEXT

    # Trim the common prefix/suffix before diffing. difflib is ~O(n*m), and these
    # files are generated: a 59 000-line mappings.json where 3 blocks changed still
    # cost 5.5s to diff line-by-line, because every identical line was compared.
    # Skipping the untouched head and tail leaves ~80 lines and takes 13ms.
    # Offsets are added back below so the @@ markers keep their real line numbers.
    head = 0
    while head < len(old_lines) and head < len(new_lines) and old_lines[head] == new_lines[head]:
        head += 1
    tail = 0
    while (
        tail < min(len(old_lines), len(new_lines)) - head
        and old_lines[len(old_lines) - 1 - tail] == new_lines[len(new_lines) - 1 - tail]
    ):
        tail += 1
    core_old = old_lines[head : len(old_lines) - tail]
    core_new = new_lines[head : len(new_lines) - tail]

    # Bail out BEFORE difflib when the trim left too much: this is the only place
    # the quadratic cost is knowable, and past the cap it runs for minutes with
    # nothing to show for it. None tells the caller to offer a download instead.
    if max(len(core_old), len(core_new)) > _DIFF_HUNK_MAX_CORE_LINES:
        return None

    opcodes = [
        (tag, o1 + head, o2 + head, n1 + head, n2 + head)
        for tag, o1, o2, n1, n2 in difflib.SequenceMatcher(
            a=core_old, b=core_new, autojunk=False
        ).get_opcodes()
    ]

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


async def diff(repo_getter, uid: str, zip_bytes: bytes, branch: str, path: str, remote_url: str | None, token: str | None = None, full: bool = False, old_path: str | None = None) -> dict:
    """Old (remote HEAD) vs new (export) content for one file in the export tree.

    Oversized/binary files return no content (too_large/binary flags) so the
    viewer never tries to render a multi-megabyte or non-text diff.

    `full` skips every size guard and returns both sides verbatim. It is for
    callers that PARSE the content rather than render it (the mappings review
    table, which keys JSON objects by mapping key): a condensed or head-truncated
    payload is not valid JSON, and in server mode the client has no export ZIP of
    its own to read the local side from.

    `old_path` is the pre-rename path, as reported by the status endpoint. A
    renamed file only exists at HEAD under its OLD name, so looking it up by
    `path` would come back empty and render the whole file as added — the left
    pane blank. Git pairs a rename by similarity, not equality, so the content
    can legitimately differ too, and that before/after is the whole point."""
    _safe_ref(branch)

    def work() -> dict:
        repo = repo_getter(uid)
        _safe_join(repo, path)  # reject a traversing path before any git/FS use
        head_path = path
        if old_path:
            _safe_join(repo, old_path)  # same traversal guard for the caller-supplied source
            head_path = old_path
        _ensure_repo(repo, remote_url)
        _sync_remote_branch(repo, branch, remote_url, token)
        old_raw = _run(repo, "show", f"HEAD:{head_path}", check=False)
        _unpack_zip_into(zip_bytes, repo)
        new_file = _safe_join(repo, path)
        new_raw = new_file.read_text(encoding="utf-8", errors="replace") if new_file.is_file() else ""
        # Derived from this file alone, NOT from `git add -A` + porcelain status:
        # the caller may hand us a ZIP holding only the requested file (assembling
        # a real project's whole export costs ~38 MB per diff click), and since
        # _unpack_zip_into wipes the tree first, a global status would then report
        # every other file as deleted. Presence on each side is all we need here.
        # ls-tree prints a line only when the path exists at HEAD. (`cat-file -e`
        # is no good here: _run swallows the exit code under check=False, so a
        # missing file and an empty one both come back as "".)
        had_old = bool(
            _run(repo, "ls-tree", "--name-only", "HEAD", "--", head_path, check=False).strip()
        )
        has_new = new_file.is_file()
        change_type = (
            "renamed"
            if old_path and had_old and has_new
            else "modified" if had_old and has_new else "added" if has_new else "deleted"
        )
        # HEAD content of an LFS-tracked file is just its pointer (we fetch with
        # SKIP_SMUDGE), so a text diff against it is meaningless — flag as binary.
        if old_raw.startswith("version https://git-lfs"):
            old_raw = ""
            old_is_lfs = True
        else:
            old_is_lfs = False
        # Verbatim, before any guard: the caller parses this rather than rendering
        # it, so truncating would hand it invalid JSON (see the `full` docstring).
        if full:
            return {
                "path": path,
                "changeType": change_type,
                "oldContent": old_raw,
                "newContent": new_raw,
                "truncated": False,
                "truncationMode": "none",
                "binary": old_is_lfs,
                **({"oldPath": old_path} if old_path else {}),
            }
        # Byte-identical already? Then git flags "modified" for a reason unrelated
        # to content: a storage-mode switch (a file committed as plain text that
        # .gitattributes now routes through the Git LFS clean filter — HEAD blob =
        # text, working tree = pointer), or an index entry that has not caught up
        # with a rewritten working tree. Which one it is cannot be told from here,
        # so the viewer reports the fact and leaves the cause out. Distinguished
        # from a pure line-ending change, which we CAN identify.
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
                **({"oldPath": old_path} if old_path else {}),
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
            condensed = _condense_hunks(old_raw, new_raw)
            if condensed is not None:
                old_h, new_h, hunk_trunc = condensed
                return result(old_h, new_h, "hunks", hunk_trunc)
            # Too scattered to condense. A head preview would be a lie here (the
            # changes are everywhere, not in the first 1000 lines), so show no
            # content and let the viewer offer the full file as a download.
            return result("", "", "too_large", True)

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
    reviewed_oid: str | None = None,
) -> dict:
    """Unpack the export and commit the selected files (all if paths is None) on
    top of the fetched remote branch, then push. Push-only flow.

    Guard against clobbering un-pulled remote work: the commit is built on top of
    the fetched remote head from the LOCAL export, which does NOT contain whatever
    the remote gained since our anchor. Pushing that would fast-forward the remote
    and silently drop those changes. So if the remote moved past our anchor,
    refuse with a `pull_required` GitError — the user must pull first.

    The anchor here is the DECISION cursor (`reviewed_oid`), falling back to the
    content one. A partial pull deliberately leaves `synced_oid` behind — the
    user took some items and kept their own version of the rest — so gating on
    content alone would refuse every subsequent push while the UI reads "up to
    date", with no escape but the complete pull they just declined. Having
    deliberated over the commit is what makes pushing safe: nothing on the remote
    is unseen, and the items they kept are exactly what they mean to push.
    """
    _safe_ref(branch)
    if synced_oid is not None:
        _safe_oid(synced_oid)
    if reviewed_oid is not None:
        _safe_oid(reviewed_oid)

    def work() -> dict:
        repo = repo_getter(uid)
        _ensure_repo(repo, remote_url)
        has_remote = _sync_remote_branch(repo, branch, remote_url, token)
        # Refuse to push over un-pulled remote changes (see docstring). Any move of
        # the remote head off our anchor — fast-forward or diverged — means the local
        # export lacks remote content, so pushing would drop it. Only guard when we
        # have an anchor; a first push (no anchor / no remote branch) is allowed.
        anchor = reviewed_oid or synced_oid
        if has_remote and anchor:
            remote_head = _run(repo, "rev-parse", "FETCH_HEAD", check=False).strip()
            if remote_head and remote_head != anchor:
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


def settings_repo_getter(uid: str) -> Path:
    # Account-level (per-instance) settings repo: organizations + users + roles.
    # Single working tree keyed by the fixed id "account".
    return _entity_repo("settings", uid)


def user_plugin_repo_getter(uid: str) -> Path:
    return _entity_repo("user-plugins", uid)
