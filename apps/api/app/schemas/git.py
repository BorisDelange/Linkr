from app.schemas.base import CamelModel


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


class GitSetSyncStateRequest(CamelModel):
    """Anchor an entity's sync state to a known remote commit (used right after a
    git import, where the cloned HEAD is the base we imported from)."""

    branch: str
    synced_oid: str


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
