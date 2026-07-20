import re

from pydantic import field_validator

from app.schemas.base import CamelModel

# A git object id is 40 hex chars (SHA-1) or 64 (SHA-256); accept an abbreviated
# form too. This is a hard guard: synced_oid/branch flow into git subprocess
# argv (see git_service._run, which has no `--` separator), so an unvalidated
# value like "--upload-pack=<cmd>" would be option-injection / RCE on the host.
_OID_RE = re.compile(r"^[0-9a-f]{7,64}$")


class GitFileChange(CamelModel):
    path: str
    change_type: str  # modified | added | deleted | renamed
    size: int = 0  # working-tree byte size (0 for deletions); drives LFS tracking in the UI


class GitStatusResponse(CamelModel):
    linked: bool
    branch: str
    files: list[GitFileChange]
    modified: int
    added: int
    deleted: int


class GitDiffResponse(CamelModel):
    path: str
    change_type: str
    old_content: str
    new_content: str
    truncated: bool = False  # some content was dropped (see truncation_mode for how)
    # "none"              = full content
    # "head"              = oversized file: first lines/bytes only
    # "hunks"             = oversized modified file condensed to its changed blocks + context
    # "eol_only"          = flagged modified but only the line-ending style differs (CRLF↔LF)
    # "no_content_change" = identical bytes; flagged modified by a storage-mode switch (e.g. text→LFS)
    truncation_mode: str = "none"
    binary: bool = False


class GitBranchesResponse(CamelModel):
    branches: list[str]
    current: str | None = None


class GitCommitInfo(CamelModel):
    oid: str
    message: str


class GitCommitResponse(CamelModel):
    committed: bool
    pushed: bool
    nothing_to_commit: bool
    commit: GitCommitInfo | None = None


class GitSyncStateResponse(CamelModel):
    linked: bool
    branch: str
    remote_head: str | None = None
    synced_oid: str | None = None
    behind: bool = False  # the remote moved past our anchor (fast-forward)
    diverged: bool = False  # the anchor is not an ancestor of the remote head (rewrite)


class GitPullSide(CamelModel):
    """One snapshot (BASE or REMOTE) of the managed files for a pull preview."""

    # name → full text content (null if absent at that commit). JSON families only.
    files: dict[str, str | None] = {}
    # name → stats ({present, rowCount?, byteSize?, lfs?}) for heavy whole-list families.
    stats: dict[str, dict] = {}


class GitPullPreviewResponse(CamelModel):
    branch: str
    remote_head: str | None = None
    synced_oid: str | None = None
    base: GitPullSide
    remote: GitPullSide


class GitSetSyncStateRequest(CamelModel):
    """Anchor an entity's sync state to a known remote commit (used right after a
    git import, where the cloned HEAD is the base we imported from)."""

    branch: str
    synced_oid: str

    @field_validator("synced_oid")
    @classmethod
    def _check_oid(cls, v: str) -> str:
        if not _OID_RE.match(v):
            raise ValueError("synced_oid must be a git object id (7–64 hex chars)")
        return v


class GitCloneRequest(CamelModel):
    url: str
    branch: str | None = None
    token: str | None = None


class GitVerifyRequest(CamelModel):
    url: str
    token: str | None = None


class GitVerifyResponse(CamelModel):
    ok: bool
    branches: list[str]
    default: str | None = None


class GitHostTokenRequest(CamelModel):
    """Store (or clear) the acting user's access token for a remote host. The host
    is derived from `url` (a full repo URL is fine). An empty/omitted token clears
    the stored credential for that host."""

    url: str
    token: str | None = None


class GitHostTokenStatus(CamelModel):
    host: str | None = None
    has_token: bool = False
