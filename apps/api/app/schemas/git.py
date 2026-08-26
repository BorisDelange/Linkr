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
    # Pre-rename path, set only when change_type is "renamed". The diff endpoint
    # needs it to find the file at HEAD, which still knows it under the old name.
    old_path: str | None = None


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
    # "no_content_change" = identical bytes, yet git flagged the file modified. Causes vary
    #                       (a storage-mode switch such as text→LFS, a stale index entry), so
    #                       the viewer states the fact rather than guessing which one.
    truncation_mode: str = "none"
    binary: bool = False
    # Echoed back when the diff was resolved against a pre-rename path, so the
    # viewer can label the left pane with the name the file used to have.
    old_path: str | None = None


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
    # Last commit every incoming item of which got an explicit decision. behind/
    # diverged are measured against THIS when set (see models/git_sync_state.py).
    reviewed_oid: str | None = None
    behind: bool = False  # the remote moved past our cursor (fast-forward)
    diverged: bool = False  # the cursor is not an ancestor of the remote head (rewrite)


class GitPullSide(CamelModel):
    """One snapshot (BASE or REMOTE) of the managed files for a pull preview."""

    # name → full text content (null if absent at that commit). JSON families only.
    files: dict[str, str | None] = {}
    # name → stats ({present, rowCount?, byteSize?, lfs?}) for heavy whole-list families.
    stats: dict[str, dict] = {}


class SourceConceptChange(CamelModel):
    """One source concept the remote list would add, remove or change."""

    key: str
    state: str  # add | delete | modify
    vocabulary: str
    code: str
    name: str = ""


class SourceConceptsDiff(CamelModel):
    """Row-level diff of the source concept list, keyed by (vocabulary, code).

    `keyed` is False when a side couldn't be parsed (absent file, unsmudged LFS
    pointer, missing identity column) — the counts are then meaningless and the
    UI must offer the file as a whole rather than show a bogus 0/0.
    """

    keyed: bool = False
    added: int = 0
    removed: int = 0
    modified: int = 0
    unchanged: int = 0
    local_total: int = 0
    remote_total: int = 0
    # The rows that moved, for the review dialog. Capped — the counts above stay
    # exact, so a truncated listing never understates the change.
    changes: list[SourceConceptChange] = []
    changes_truncated: bool = False


class GitPullPreviewResponse(CamelModel):
    branch: str
    remote_head: str | None = None
    synced_oid: str | None = None
    base: GitPullSide
    remote: GitPullSide
    source_concepts_diff: SourceConceptsDiff = SourceConceptsDiff()


class GitSetSyncStateRequest(CamelModel):
    """Anchor an entity's sync state to a known remote commit (used right after a
    git import, where the cloned HEAD is the base we imported from)."""

    branch: str
    synced_oid: str
    # True → advance ONLY the decision cursor: the user deliberated over every
    # incoming item but kept their own version of some, so we do NOT hold this
    # commit's content and the 3-way base must stay put. Default False = a
    # complete pull / import / push, where both cursors move together.
    reviewed_only: bool = False

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


class SettingsGitConfig(CamelModel):
    """The settings-scope git remote ({url, branch}). authToken is accepted on write
    (stripped + stored per (user, host)) but never returned."""

    url: str | None = None
    branch: str | None = None
    auth_token: str | None = None


class SettingsGitConfigResponse(CamelModel):
    url: str | None = None
    branch: str | None = None


class SettingsImportResponse(CamelModel):
    orgs_created: int = 0
    orgs_updated: int = 0
    roles_created: int = 0
    roles_updated: int = 0
    users_created: int = 0
    users_updated: int = 0
    warnings: list[str] = []


class SettingsPullPreview(CamelModel):
    """How many of each family the remote settings tree holds (None = the family's
    file is absent from the remote), so the pull dialog can offer a per-family choice."""

    organizations: int | None = None
    users: int | None = None
    roles: int | None = None


class GitContentStatusEntry(CamelModel):
    """A git-linked entity whose content is not reconstituted (pending/failed)."""

    scope: str
    entity_id: str
    status: str


class GitContentStatusUpdate(CamelModel):
    # workspace_id is NOT accepted from the body — the row is tagged to the
    # path-authorized workspace, so a caller with write on workspace A can't write
    # or clear a badge belonging to workspace B.
    scope: str
    entity_id: str
    status: str  # 'pending' | 'failed'
