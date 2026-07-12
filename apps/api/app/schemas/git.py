from app.schemas.base import CamelModel


class GitFileChange(CamelModel):
    path: str
    change_type: str  # modified | added | deleted | renamed


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
