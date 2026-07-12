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
    truncated: bool = False  # preview capped to the first lines/bytes of a large file
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
