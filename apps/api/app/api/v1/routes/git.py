"""Server-side git versioning endpoints (push-only) for projects & workspaces.

Each op needs the entity's export ZIP. For mapping projects the server now BUILDS
it (assemble_mapping_project_zip) when the client sends no file — the fullstack
path that offloads the browser; an uploaded file is still accepted (front-only /
transition). Other scopes still receive the client-built ZIP. The router unpacks
the ZIP into the entity's git working tree and runs the requested git operation
(status / diff / commit+push / branch list). Clone is used by the import flow to
pull a remote in server mode (no in-browser CORS proxy needed).

Read ops (status/diff/branches) require viewer; write ops (commit/push) require
editor. A read op takes an uploaded export only from a writer: it lands in the
entity's repository. A route reading a project or workspace tree also needs the
read of every resource that tree carries.

Access tokens are stored per (user, host) by git_credential_service and
resolved for the acting user from the remote URL — never per entity, so one user
never pushes with another's token. Tokens are decrypted server-side and never
leave the server.
"""

import asyncio
import tempfile
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

import structlog
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Response,
    UploadFile,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit, deferred
from app.core.database import get_db
from app.core.deps import get_current_admin, get_current_user
from app.core.permissions import (
    effective_workspace_permissions,
    has_global_permission,
    has_permission,
    has_project_permission,
    require_permission,
    require_project_permission,
    unreadable_project_tree_reads,
)
from app.models.mapping_project import MappingProject
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.git import (
    GitBranchesResponse,
    GitCloneRequest,
    GitCommitResponse,
    GitContentStatusEntry,
    GitContentStatusUpdate,
    GitDiffResponse,
    GitHostTokenRequest,
    GitHostTokenStatus,
    GitProposalResponse,
    GitPullPreviewResponse,
    GitPullScoresRequest,
    GitSetSyncStateRequest,
    GitStatusResponse,
    GitSyncStateResponse,
    GitThreeWayResponse,
    GitVerifyRequest,
    GitVerifyResponse,
    SettingsGitConfig,
    SettingsGitConfigResponse,
    SettingsImportResponse,
)
from app.services import (
    app_settings_service,
    blob_store,
    catalog_remote_service,
    git_content_status_service,
    git_credential_service,
    git_service,
    git_sync_state_service,
    settings_import_service,
    workspace_service,
)
from app.services.mapping_project_export_assemble import (
    assemble_mapping_project_file_zip,
    assemble_mapping_project_zip,
)
from app.services.project_export_assemble import assemble_project_zip
from app.services.settings_export_assemble import (
    SettingsSelection,
    assemble_settings_zip,
)
from app.services.workspace_export_assemble import (
    WorkspaceExportOptions,
    assemble_workspace_zip,
    unreadable_project_uids,
    unreadable_sections,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/git", tags=["git"])


async def _mapping_project_zip_bytes(db, mp, file: UploadFile | None) -> bytes:
    """The mapping project's export ZIP: server-built when the client sends no
    file (the fullstack path that offloads the browser), else the uploaded bytes
    (front-only / transition). Both feed the same git flow."""
    if file is not None:
        return await file.read()
    return await _assembled(assemble_mapping_project_zip(db, mp), "mapping project")


async def _workspace_zip_bytes(db, ws, file: UploadFile | None) -> bytes:
    """The workspace's export ZIP: server-built when the client sends no file (the
    fullstack path that offloads the browser), else the uploaded bytes (front-only
    / transition). The git flow always versions the full workspace (all sections,
    no per-entity data, no excludes) — the section/include-data/exclude toggles are
    an Export-button concern, not a git-sync one (the client's git buildZip never
    forwards them), so the default options reproduce what the front committed."""
    if file is not None:
        return await file.read()
    return await _assembled(
        assemble_workspace_zip(db, ws, WorkspaceExportOptions()), "workspace"
    )


async def _sql_collection_zip_bytes(db, collection, file: UploadFile | None) -> bytes:
    """The SQL collection's export ZIP: server-built when the client sends no file
    (fullstack path), else the uploaded bytes (front-only / transition)."""
    if file is not None:
        return await file.read()
    from app.services.workspace_export_assemble import assemble_sql_collection_zip

    return await _assembled(
        assemble_sql_collection_zip(db, collection), "SQL collection"
    )


async def _project_zip_bytes(db, project, file: UploadFile | None) -> bytes:
    """The project's export ZIP: server-built when the client sends no file (the
    fullstack path that offloads the browser), else the uploaded bytes (front-only
    / transition). Data-file inclusion follows project.config.versionedDataFiles,
    reproduced identically by both the client build and the server assembler."""
    if file is not None:
        return await file.read()
    return await _assembled(assemble_project_zip(db, project), "project")


def _git_http_error(exc: git_service.GitError) -> HTTPException:
    """A structured 400 the UI can turn into a friendly message: `code` is the
    stable label, `message` the raw (scrubbed) git output shown on demand."""
    return HTTPException(
        status.HTTP_400_BAD_REQUEST,
        detail={"code": getattr(exc, "code", "unknown"), "message": str(exc)},
    )


async def _guard(coro) -> dict:
    """Run a git service coroutine, mapping GitError → structured 400."""
    try:
        return await coro
    except git_service.GitError as exc:
        raise _git_http_error(exc) from exc


async def _writer_upload(file: UploadFile | None, may_write) -> UploadFile | None:
    """A read route builds the export itself. One sent by the client is written into
    the entity's repository, so only a caller `may_write()` approves may send it."""
    if file is not None and not await may_write():
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only a writer of this entity may send its export"
        )
    return file


def _tree_refused(what: str) -> HTTPException:
    return HTTPException(
        status.HTTP_403_FORBIDDEN,
        detail={
            "code": "unreadable_content",
            "message": f"This {what} holds content your role does not read, so its versioned tree is not available to you.",
        },
    )


def _project_tree(permission: str):
    """The path project, for a route that reads or writes its whole versioned tree:
    beside `permission`, every read of what that tree carries."""

    async def dep(
        project=Depends(require_project_permission(permission)),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        if await unreadable_project_tree_reads(db, project, user):
            raise _tree_refused("project")
        return project

    return dep


def _project_writer(db, project, user: User):
    return lambda: has_project_permission(db, project, user, "project-settings:write")


def _workspace_writer(db, workspace_id: str, user: User, permission: str):
    return lambda: has_permission(db, workspace_id, user, permission)


async def _pushed(user: User, as_job: deferred.AsJob | None, commit, anchor: tuple[str, str, str] | None = None):
    """Commit and push, past a gateway's timeout: a push of a big repository (LFS)
    takes minutes, so after `deferred.WAIT_SECONDS` it goes on as a job of the
    panel (core/deferred). `anchor` (scope, id, branch): the sync anchor to move to
    a pushed commit."""

    async def work() -> dict:
        result = await _guard(commit)
        if anchor and result.get("pushed") and result.get("commit"):
            async with deferred.session() as session:
                await git_sync_state_service.set_oid(session, *anchor, result["commit"]["oid"])
        return result

    return await deferred.respond(user.id, work, as_job)


async def _assembled(coro, what: str) -> bytes:
    """Build an export ZIP server-side, reporting a failure as itself.

    This step runs BEFORE the git call, so it is outside `_guard` and an error in
    it used to reach the catch-all handler as a bare 500 "Internal server error" —
    which the versioning UI then showed as "something went wrong with the git
    operation", pointing the user at their token and their remote for a failure
    that never touched either. The exception text (a missing dataset file, an
    encoding error) is the whole diagnosis, so it must survive to the client.
    """
    try:
        return await coro
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("git_export_assemble_failed", entity=what)
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "export_failed",
                "message": f"Could not build the {what} export: {exc}",
            },
        ) from exc


def _remote_url(entity) -> str | None:
    cfg = getattr(entity, "git_remote_config", None) or {}
    return cfg.get("url") or None


async def _token(db: AsyncSession, user: User, entity) -> str | None:
    """The acting user's git token for this entity's remote host (per-user, not
    per-entity), or None when the entity is unlinked or the user has no token."""
    return await git_credential_service.token_for_url(db, user, _remote_url(entity))


async def _sync_state(
    db, scope, repo_getter, entity_id, branch, remote_url, token
) -> dict:
    """Run the git sync-state check (behind/diverged) reading the DB anchor. No ZIP:
    the check only compares oids on the remote, so the client needn't rebuild the
    export just to learn it's out of date."""
    row = await git_sync_state_service.get(db, scope, entity_id, branch)
    result = await _guard(
        git_service.sync_state(
            repo_getter,
            entity_id,
            branch,
            remote_url,
            (row.synced_oid or None) if row else None,
            token,
            reviewed_oid=row.reviewed_oid if row else None,
        )
    )
    # Deliberately writes nothing: the anchor is recorded by a pull/import that
    # actually applied the content (set-sync-state), never inferred here. See the
    # note in git_service.sync_state — the scratch repo's HEAD tracks the remote,
    # so adopting it persisted a sync that never happened.
    return {"linked": remote_url is not None, "branch": branch, **result}



# --- 3-way pull (every scope) ------------------------------------------------


async def _three_way(db, scope, entity_id, repo_getter, zip_bytes, branch, remote_url, token) -> dict:
    """What the remote brought since the sync anchor, file by file, with the three
    versions (plan §9.2). Read access: nothing is written until the client
    re-imports the merged tree."""
    row = await git_sync_state_service.get(db, scope, entity_id, branch)
    return await _guard(
        git_service.three_way(
            repo_getter, entity_id, zip_bytes, branch, remote_url,
            (row.synced_oid or None) if row else None, token,
        )
    )


def _valid_override(op: object) -> bool:
    """One decision of a merged-tree request: exactly one of `text` (a string),
    `remote: true` or `delete: true`, plus an optional `localOid`."""
    if not isinstance(op, dict) or not set(op) <= {"text", "remote", "delete", "localOid"}:
        return False
    if "localOid" in op and op["localOid"] is not None and not isinstance(op["localOid"], str):
        return False
    actions = [k for k in ("text", "remote", "delete") if k in op]
    if len(actions) != 1:
        return False
    return isinstance(op["text"], str) if actions[0] == "text" else op[actions[0]] is True


async def _merged_tree(repo_getter, entity_id, zip_bytes, branch, remote_url, token, remote_head, overrides):
    """The local export with the pull's decisions applied, as the ZIP the client
    re-imports. `overrides` is JSON: {path: {"text"} | {"remote": true} | {"delete": true}}."""
    import json as _json_mod

    try:
        parsed = _json_mod.loads(overrides or "{}")
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "overrides is not JSON") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "overrides must be an object")
    for path, op in parsed.items():
        if not _valid_override(op):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"invalid override for {path!r}")
    try:
        data = await git_service.merged_tree(
            repo_getter, entity_id, zip_bytes, branch, remote_url, remote_head, parsed, token,
        )
    except git_service.LocalChangedError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"code": exc.code, "message": str(exc), "paths": exc.paths},
        ) from exc
    except git_service.GitError as exc:
        raise _git_http_error(exc) from exc
    return Response(content=data, media_type="application/zip")


# --- Merge requests (every scope) --------------------------------------------


# TODO(git-proposals): set aside on 2026-11-05 with "Propose changes" (twin of
# apps/web/src/lib/git-proposals.ts). The review mode is no longer enforced: its
# switch is hidden, so a workspace left in it could not push nor be switched back.
GIT_PROPOSALS_ENABLED = False


def _require_git_proposals() -> None:
    if not GIT_PROPOSALS_ENABLED:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not Found")


_PROPOSALS = [Depends(_require_git_proposals)]


async def _propose(
    db, user, scope, entity_id, repo_getter, zip_bytes, target_branch, remote_url, token,
    title, description, paths,
) -> dict:
    """Push the local changes on a branch of their own, started from the remote
    `target_branch`, and open a merge request (GitLab) / pull request (GitHub)
    into it with the user's token. The sync anchor does not move: nothing is on
    the target branch until the forge merges it, and the pull then brings it back."""
    from app.services import forge_service, git_proposal_service

    if remote_url is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not linked to a git remote")
    row = await git_sync_state_service.get(db, scope, entity_id, target_branch)
    branch = git_proposal_service.proposal_branch(user.username)
    result = await _guard(
        git_service.commit_push(
            repo_getter, entity_id, zip_bytes, target_branch, title, remote_url, token, paths,
            *_push_anchors(row), push_branch=branch,
        )
    )
    if result.get("nothingToCommit"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={"code": "nothing_to_commit", "message": "Nothing to propose: no change from the target branch."},
        )
    try:
        forge = await forge_service.detect(remote_url, token)
        proposal = await forge_service.open_proposal(
            remote_url, token, source=branch, target=target_branch, title=title, description=description,
        )
    except forge_service.ForgeError as exc:
        # The branch is pushed either way: say so, so the request can be opened by hand.
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={"code": f"forge_{exc.code}", "message": str(exc), "branch": branch},
        ) from exc
    saved = await git_proposal_service.record(
        db, scope=scope, entity_id=entity_id, branch=branch, target_branch=target_branch,
        forge=forge.kind, proposal=proposal, title=title, author_id=user.id,
    )
    return GitProposalResponse.model_validate(saved).model_dump(by_alias=True, mode="json")


async def _proposals(db, scope, entity_id, remote_url, token) -> list[dict]:
    from app.services import git_proposal_service

    rows = await git_proposal_service.list_refreshed(db, scope, entity_id, remote_url, token)
    return [GitProposalResponse.model_validate(r).model_dump(by_alias=True, mode="json") for r in rows]


async def _refuse_direct_push(db, workspace_id: str | None) -> None:
    """A workspace in review mode takes changes as merge requests only — for itself
    and every entity in it (its git_push_policy)."""
    if not GIT_PROPOSALS_ENABLED or not workspace_id:
        return
    ws = await db.get(Workspace, workspace_id)
    if ws is not None and ws.git_push_policy == "review":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={"code": "review_required", "message": "This workspace takes changes as merge requests only."},
        )

async def _apply_sync_state(db, scope: str, entity_id: str, body) -> None:
    """Record a `set-sync-state` request, honouring `reviewedOnly`.

    A partial-but-fully-deliberated pull advances only the decision cursor: we do
    not hold this commit's content, so the 3-way base must not move or it would
    absorb what the user explicitly declined.
    """
    if body.reviewed_only:
        await git_sync_state_service.set_reviewed_oid(
            db, scope, entity_id, body.branch, body.synced_oid
        )
    else:
        await git_sync_state_service.set_oid(
            db, scope, entity_id, body.branch, body.synced_oid
        )


def _default_branch(entity, fallback: str | None) -> str:
    if fallback:
        return fallback
    cfg = getattr(entity, "git_remote_config", None) or {}
    return cfg.get("branch") or "main"


def _push_anchors(row) -> tuple[str | None, str | None]:
    """The (synced, reviewed) cursors to hand `commit_push`, as real oids or None.

    `synced_oid` is NOT NULL and carries "" for a row that has only ever been
    reviewed, so it must be coerced before it reaches `_safe_oid` — which rejects
    "" and would turn a benign unanchored state into a 400. Centralised here
    because the coercion is load-bearing and was previously hand-repeated at
    every call site, one omission away from that bug.
    """
    if row is None:
        return None, None
    return (row.synced_oid or None), (row.reviewed_oid or None)


# --- Project scope --------------------------------------------------------


@router.post("/projects/{project_uid}/status", response_model=GitStatusResponse)
async def project_status(
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    project=Depends(_project_tree("project-settings:read")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    file = await _writer_upload(file, _project_writer(db, project, user))
    result = await _guard(
        git_service.status(
            git_service.project_repo_getter,
            project.uid,
            await _project_zip_bytes(db, project, file),
            _default_branch(project, branch),
            _remote_url(project),
            await _token(db, user, project),
        )
    )
    return {"linked": _remote_url(project) is not None, **result}


@router.post("/projects/{project_uid}/diff", response_model=GitDiffResponse)
async def project_diff(
    file: UploadFile | None = File(None),
    path: str = Form(...),
    branch: str | None = Form(None),
    # Set by the client for a renamed file: HEAD only knows it under this name.
    old_path: str | None = Form(None),
    project=Depends(_project_tree("project-settings:read")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    file = await _writer_upload(file, _project_writer(db, project, user))
    return await _guard(
        git_service.diff(
            git_service.project_repo_getter,
            project.uid,
            await _project_zip_bytes(db, project, file),
            _default_branch(project, branch),
            path,
            _remote_url(project),
            await _token(db, user, project),
            old_path=old_path,
        )
    )


@router.get("/projects/{project_uid}/branches", response_model=GitBranchesResponse)
async def project_branches(
    project=Depends(require_project_permission("project-settings:read")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await git_service.branches(
        git_service.project_repo_getter,
        project.uid,
        _remote_url(project),
        await _token(db, user, project),
    )


@router.post("/projects/{project_uid}/propose", response_model=GitProposalResponse, dependencies=_PROPOSALS)
async def project_propose(
    title: str = Form(...),
    description: str = Form(""),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    file: UploadFile | None = File(None),
    project=Depends(_project_tree("project-settings:write")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await _propose(
        db, user, "projects", project.uid, git_service.project_repo_getter,
        await _project_zip_bytes(db, project, file), _default_branch(project, branch),
        _remote_url(project), await _token(db, user, project), title, description, paths,
    )


@router.get("/projects/{project_uid}/proposals", response_model=list[GitProposalResponse], dependencies=_PROPOSALS)
async def project_proposals(
    project=Depends(require_project_permission("project-settings:read")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await _proposals(db, "projects", project.uid, _remote_url(project), await _token(db, user, project))


@router.post("/projects/{project_uid}/three-way", response_model=GitThreeWayResponse)
async def project_three_way(
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    project=Depends(_project_tree("project-settings:read")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    file = await _writer_upload(file, _project_writer(db, project, user))
    return await _three_way(
        db, "projects", project.uid, git_service.project_repo_getter,
        await _project_zip_bytes(db, project, file), _default_branch(project, branch),
        _remote_url(project), await _token(db, user, project),
    )


@router.post("/projects/{project_uid}/merged-tree")
async def project_merged_tree(
    remote_head: str = Form(..., alias="remoteHead"),
    overrides: str = Form("{}"),
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    project=Depends(_project_tree("project-settings:read")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    file = await _writer_upload(file, _project_writer(db, project, user))
    return await _merged_tree(
        git_service.project_repo_getter, project.uid, await _project_zip_bytes(db, project, file),
        _default_branch(project, branch), _remote_url(project), await _token(db, user, project),
        remote_head, overrides,
    )


@router.post("/projects/{project_uid}/commit-push", response_model=GitCommitResponse)
async def project_commit_push(
    file: UploadFile | None = File(None),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    project=Depends(_project_tree("project-settings:write")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if _remote_url(project) is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Project is not linked to a git remote"
        )
    await _refuse_direct_push(db, project.workspace_id)
    resolved_branch = _default_branch(project, branch)
    row = await git_sync_state_service.get(db, "projects", project.uid, resolved_branch)
    return await _pushed(
        user,
        deferred.AsJob("Git push", project_uid=project.uid),
        git_service.commit_push(
            git_service.project_repo_getter,
            project.uid,
            await _project_zip_bytes(db, project, file),
            resolved_branch,
            message,
            _remote_url(project),
            await _token(db, user, project),
            paths,
            *_push_anchors(row),
        ),
        # Anchored: without it the push guard never fires, and a second editor's
        # push silently overwrote the first one's work.
        ("projects", project.uid, resolved_branch),
    )


@router.get(
    "/projects/{project_uid}/sync-state",
    response_model=GitSyncStateResponse,
)
async def project_sync_state(
    branch: str | None = None,
    project=Depends(require_project_permission("project-settings:read")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Where the local project stands vs the remote branch (behind/diverged),
    reading the DB anchor. No ZIP — the check only compares remote oids, so the
    client needn't rebuild the export just to learn it's out of date."""
    return await _sync_state(
        db,
        "projects",
        git_service.project_repo_getter,
        project.uid,
        _default_branch(project, branch),
        _remote_url(project),
        await _token(db, user, project),
    )


@router.post(
    "/projects/{project_uid}/set-sync-state",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def project_set_sync_state(
    body: GitSetSyncStateRequest,
    project=Depends(require_project_permission("project-settings:write")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Anchor the project's sync state to a known remote commit — called after a
    git import or a pull so it has a base to compare against (a later push
    elsewhere is then detected as 'behind'). Write access required."""
    await _apply_sync_state(db, "projects", project.uid, body)


# --- Workspace scope ------------------------------------------------------


async def _load_workspace(workspace_id: str, db: AsyncSession, _member) -> Workspace:
    ws = await workspace_service.get(db, workspace_id)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    return ws


async def _load_workspace_tree(workspace_id: str, db: AsyncSession, user: User) -> Workspace:
    """The workspace, for a route that reads or writes its whole versioned tree. A
    tree without a project or a section the caller may not read would show it as
    deleted and commit that deletion, and the repository's history holds its
    content either way, so the route is refused rather than filtered."""
    ws = await _load_workspace(workspace_id, db, user)
    if await unreadable_project_uids(db, ws.id, user):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "code": "hidden_projects",
                "message": "This workspace holds a project you have no access to, so its versioned tree is not available to you.",
            },
        )
    if await unreadable_sections(db, ws.id, user):
        raise _tree_refused("workspace")
    return ws


@router.post("/workspaces/{workspace_id}/status", response_model=GitStatusResponse)
async def workspace_status(
    workspace_id: str,
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace_tree(workspace_id, db, _member)
    file = await _writer_upload(file, _workspace_writer(db, ws.id, _member, "workspace-settings:write"))
    result = await _guard(
        git_service.status(
            git_service.workspace_repo_getter,
            ws.id,
            await _workspace_zip_bytes(db, ws, file),
            _default_branch(ws, branch),
            _remote_url(ws),
            await _token(db, _member, ws),
        )
    )
    return {"linked": _remote_url(ws) is not None, **result}


@router.post("/workspaces/{workspace_id}/diff", response_model=GitDiffResponse)
async def workspace_diff(
    workspace_id: str,
    file: UploadFile | None = File(None),
    path: str = Form(...),
    branch: str | None = Form(None),
    # Set by the client for a renamed file: HEAD only knows it under this name.
    old_path: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace_tree(workspace_id, db, _member)
    file = await _writer_upload(file, _workspace_writer(db, ws.id, _member, "workspace-settings:write"))
    return await _guard(
        git_service.diff(
            git_service.workspace_repo_getter,
            ws.id,
            await _workspace_zip_bytes(db, ws, file),
            _default_branch(ws, branch),
            path,
            _remote_url(ws),
            await _token(db, _member, ws),
            old_path=old_path,
        )
    )


@router.get("/workspaces/{workspace_id}/branches", response_model=GitBranchesResponse)
async def workspace_branches(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace(workspace_id, db, _member)
    return await git_service.branches(
        git_service.workspace_repo_getter,
        ws.id,
        _remote_url(ws),
        await _token(db, _member, ws),
    )


@router.post("/workspaces/{workspace_id}/commit-push", response_model=GitCommitResponse)
async def workspace_commit_push(
    workspace_id: str,
    file: UploadFile | None = File(None),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:write")),
):
    ws = await _load_workspace_tree(workspace_id, db, _member)
    if _remote_url(ws) is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Workspace is not linked to a git remote"
        )
    await _refuse_direct_push(db, ws.id)
    row = await git_sync_state_service.get(db, "workspaces", ws.id, _default_branch(ws, branch))
    return await _pushed(
        _member,
        deferred.AsJob("Git push", workspace_id=ws.id),
        git_service.commit_push(
            git_service.workspace_repo_getter,
            ws.id,
            await _workspace_zip_bytes(db, ws, file),
            _default_branch(ws, branch),
            message,
            _remote_url(ws),
            await _token(db, _member, ws),
            paths,
            *_push_anchors(row),
        ),
        # Anchored like the other pullable scopes: without it the push guard never
        # fires, and a second editor's push silently overwrote the first one's work.
        anchor=("workspaces", ws.id, _default_branch(ws, branch)),
    )


@router.get("/workspaces/{workspace_id}/sync-state", response_model=GitSyncStateResponse)
async def workspace_sync_state(
    workspace_id: str,
    branch: str | None = None,
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace(workspace_id, db, _member)
    return await _sync_state(
        db,
        "workspaces",
        git_service.workspace_repo_getter,
        ws.id,
        _default_branch(ws, branch),
        _remote_url(ws),
        await _token(db, _member, ws),
    )


@router.post("/workspaces/{workspace_id}/set-sync-state", status_code=status.HTTP_204_NO_CONTENT)
async def workspace_set_sync_state(
    workspace_id: str,
    body: GitSetSyncStateRequest,
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:write")),
):
    ws = await _load_workspace(workspace_id, db, _member)
    await _apply_sync_state(db, "workspaces", ws.id, body)


@router.post("/workspaces/{workspace_id}/propose", response_model=GitProposalResponse, dependencies=_PROPOSALS)
async def workspace_propose(
    workspace_id: str,
    title: str = Form(...),
    description: str = Form(""),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    file: UploadFile | None = File(None),
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:write")),
):
    ws = await _load_workspace_tree(workspace_id, db, _member)
    return await _propose(
        db, _member, "workspaces", ws.id, git_service.workspace_repo_getter,
        await _workspace_zip_bytes(db, ws, file), _default_branch(ws, branch), _remote_url(ws),
        await _token(db, _member, ws), title, description, paths,
    )


@router.get("/workspaces/{workspace_id}/proposals", response_model=list[GitProposalResponse], dependencies=_PROPOSALS)
async def workspace_proposals(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace(workspace_id, db, _member)
    return await _proposals(db, "workspaces", ws.id, _remote_url(ws), await _token(db, _member, ws))


@router.post("/workspaces/{workspace_id}/three-way", response_model=GitThreeWayResponse)
async def workspace_three_way(
    workspace_id: str,
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace_tree(workspace_id, db, _member)
    file = await _writer_upload(file, _workspace_writer(db, ws.id, _member, "workspace-settings:write"))
    return await _three_way(
        db, "workspaces", ws.id, git_service.workspace_repo_getter,
        await _workspace_zip_bytes(db, ws, file), _default_branch(ws, branch),
        _remote_url(ws), await _token(db, _member, ws),
    )


@router.post("/workspaces/{workspace_id}/merged-tree")
async def workspace_merged_tree(
    workspace_id: str,
    remote_head: str = Form(..., alias="remoteHead"),
    overrides: str = Form("{}"),
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace_tree(workspace_id, db, _member)
    file = await _writer_upload(file, _workspace_writer(db, ws.id, _member, "workspace-settings:write"))
    return await _merged_tree(
        git_service.workspace_repo_getter, ws.id, await _workspace_zip_bytes(db, ws, file),
        _default_branch(ws, branch), _remote_url(ws), await _token(db, _member, ws),
        remote_head, overrides,
    )


# --- Mapping project scope ------------------------------------------------


async def _load_mapping_project(
    mapping_project_id: str, db: AsyncSession, user: User, permission: str
):
    from app.core.permissions import check_workspace_permission
    from app.services import mapping_project_service

    mp = await mapping_project_service.get(db, mapping_project_id)
    if mp is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mapping project not found")
    await check_workspace_permission(db, mp.workspace_id, user, permission)
    return mp


@router.post(
    "/mapping-projects/{mapping_project_id}/status", response_model=GitStatusResponse
)
async def mapping_project_status(
    mapping_project_id: str,
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:read"
    )
    file = await _writer_upload(file, _workspace_writer(db, mp.workspace_id, user, "concept-mapping:write"))
    result = await _guard(
        git_service.status(
            git_service.mapping_project_repo_getter,
            mp.id,
            await _mapping_project_zip_bytes(db, mp, file),
            _default_branch(mp, branch),
            _remote_url(mp),
            await _token(db, user, mp),
        )
    )
    return {"linked": _remote_url(mp) is not None, **result}


@router.post(
    "/mapping-projects/{mapping_project_id}/diff", response_model=GitDiffResponse
)
async def mapping_project_diff(
    mapping_project_id: str,
    file: UploadFile | None = File(None),
    path: str = Form(...),
    branch: str | None = Form(None),
    # Set by the client for a renamed file: HEAD only knows it under this name.
    old_path: str | None = Form(None),
    # Both sides verbatim, for callers that PARSE the content (the mappings review
    # table) rather than render it — a truncated payload is not valid JSON.
    full: bool = Form(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:read"
    )
    file = await _writer_upload(file, _workspace_writer(db, mp.workspace_id, user, "concept-mapping:write"))
    # Only the requested file is assembled: the full export tree is ~38 MB for a
    # real project, and building it per diff click cost about a minute.
    zip_bytes = (
        await file.read()
        if file is not None
        else await _assembled(
            assemble_mapping_project_file_zip(db, mp, path), "mapping project file"
        )
    )
    return await _guard(
        git_service.diff(
            git_service.mapping_project_repo_getter,
            mp.id,
            zip_bytes,
            _default_branch(mp, branch),
            path,
            _remote_url(mp),
            await _token(db, user, mp),
            full,
            old_path=old_path,
        )
    )


@router.get(
    "/mapping-projects/{mapping_project_id}/branches",
    response_model=GitBranchesResponse,
)
async def mapping_project_branches(
    mapping_project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:read"
    )
    return await git_service.branches(
        git_service.mapping_project_repo_getter,
        mp.id,
        _remote_url(mp),
        await _token(db, user, mp),
    )


@router.get(
    "/mapping-projects/{mapping_project_id}/sync-state",
    response_model=GitSyncStateResponse,
)
async def mapping_project_sync_state(
    mapping_project_id: str,
    branch: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:read"
    )
    return await _sync_state(
        db,
        "mapping-projects",
        git_service.mapping_project_repo_getter,
        mp.id,
        _default_branch(mp, branch),
        _remote_url(mp),
        await _token(db, user, mp),
    )


@router.get(
    "/mapping-projects/{mapping_project_id}/pull-preview",
    response_model=GitPullPreviewResponse,
)
async def mapping_project_pull_preview(
    mapping_project_id: str,
    branch: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Fetch BASE + REMOTE managed-file content so the client can 3-way merge them
    against its DB (LOCAL) and present a resolution UI. Read access is enough — the
    pull only writes the DB once the user resolves (via the entity's own APIs)."""
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:read"
    )
    row = await git_sync_state_service.get(
        db, "mapping-projects", mp.id, _default_branch(mp, branch)
    )
    # The local source CSV rides along so the preview can diff the concept list
    # row by row (added/removed/modified) rather than just "the blob changed".
    local_source_csv = None
    if (
        mp.source_type == "file"
        and mp.raw_file_sha
        and blob_store.exists(mp.raw_file_sha)
    ):
        local_source_csv = await blob_store.read_bytes(mp.raw_file_sha)
    # The project NAMES its identity columns; a source CSV is the user's own file,
    # so its headers are whatever they were on import.
    source_column_mapping = (mp.file_source_data or {}).get("columnMapping")
    return await _guard(
        git_service.pull_preview(
            git_service.mapping_project_repo_getter,
            mp.id,
            _default_branch(mp, branch),
            _remote_url(mp),
            (row.synced_oid or None) if row else None,
            await _token(db, user, mp),
            local_source_csv=local_source_csv,
            source_column_mapping=source_column_mapping,
        )
    )


@router.post("/mapping-projects/{mapping_project_id}/propose", response_model=GitProposalResponse, dependencies=_PROPOSALS)
async def mapping_project_propose(
    mapping_project_id: str,
    title: str = Form(...),
    description: str = Form(""),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    file: UploadFile | None = File(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(mapping_project_id, db, user, "concept-mapping:write")
    return await _propose(
        db, user, "mapping-projects", mp.id, git_service.mapping_project_repo_getter,
        await _mapping_project_zip_bytes(db, mp, file), _default_branch(mp, branch),
        _remote_url(mp), await _token(db, user, mp), title, description, paths,
    )


@router.get("/mapping-projects/{mapping_project_id}/proposals", response_model=list[GitProposalResponse], dependencies=_PROPOSALS)
async def mapping_project_proposals(
    mapping_project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(mapping_project_id, db, user, "concept-mapping:read")
    return await _proposals(db, "mapping-projects", mp.id, _remote_url(mp), await _token(db, user, mp))


@router.post("/mapping-projects/{mapping_project_id}/three-way", response_model=GitThreeWayResponse)
async def mapping_project_three_way(
    mapping_project_id: str,
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(mapping_project_id, db, user, "concept-mapping:read")
    file = await _writer_upload(file, _workspace_writer(db, mp.workspace_id, user, "concept-mapping:write"))
    return await _three_way(
        db, "mapping-projects", mp.id, git_service.mapping_project_repo_getter,
        await _mapping_project_zip_bytes(db, mp, file), _default_branch(mp, branch),
        _remote_url(mp), await _token(db, user, mp),
    )


@router.post("/mapping-projects/{mapping_project_id}/merged-tree")
async def mapping_project_merged_tree(
    mapping_project_id: str,
    remote_head: str = Form(..., alias="remoteHead"),
    overrides: str = Form("{}"),
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(mapping_project_id, db, user, "concept-mapping:read")
    file = await _writer_upload(file, _workspace_writer(db, mp.workspace_id, user, "concept-mapping:write"))
    return await _merged_tree(
        git_service.mapping_project_repo_getter, mp.id, await _mapping_project_zip_bytes(db, mp, file),
        _default_branch(mp, branch), _remote_url(mp), await _token(db, user, mp),
        remote_head, overrides,
    )


@router.get("/mapping-projects/{mapping_project_id}/pull-file")
async def mapping_project_pull_file(
    mapping_project_id: str,
    path: str,
    branch: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Stream the raw bytes of a managed file (source CSV, scores parquet) at the
    remote head, LFS resolved — used when the pull's block choice is 'take remote'
    for a whole-list family. Only the pull's managed heavy files are allowed."""
    from fastapi.responses import Response

    if path != "source-concepts.csv":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "path is not a pullable file")
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:read"
    )
    data = await _guard(
        git_service.pull_file_bytes(
            git_service.mapping_project_repo_getter,
            mp.id,
            _default_branch(mp, branch),
            path,
            _remote_url(mp),
            await _token(db, user, mp),
        )
    )
    audit.bind(action="download", workspace_id=mp.workspace_id,
               detail=f"mapping project {mp.id} {path} at the remote head ({len(data)} bytes)")
    return Response(content=data, media_type="application/octet-stream")


@router.post("/mapping-projects/{mapping_project_id}/pull-scores")
async def mapping_project_pull_scores(
    mapping_project_id: str,
    body: GitPullScoresRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Take the versioned score methods the remote changed: each method's rows
    are replaced by its CSV at the remote head, read here rather than shipped to
    the browser and back (a method's CSV runs to hundreds of MB). Local methods
    the pull does not name are kept. Returns the new ScoresIndex, null when no
    scores remain."""
    from app.services import scores_export
    from app.services.data import scores_service

    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:write"
    )
    paths = [(m, scores_service.csv_path_for_method(m)) for m in body.methods]
    if any(p is None for _, p in paths):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid score method")
    branch = _default_branch(mp, body.branch)
    token = await _token(db, user, mp)
    remote = _remote_url(mp)
    mp_id, workspace_id = mp.id, mp.workspace_id

    async def work():
        async with scores_export.scores_lock(mp_id), deferred.session() as session:
            fresh = await session.get(MappingProject, mp_id)
            if fresh is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Mapping project not found")
            with tempfile.TemporaryDirectory() as tmp:
                csvs: list[tuple[str, str]] = []
                for i, (method, path) in enumerate(paths):
                    data = await _guard(
                        git_service.pull_file_bytes(
                            git_service.mapping_project_repo_getter,
                            mp_id, branch, path, remote, token,
                        )
                    )
                    target = Path(tmp) / f"{i}.csv"
                    await asyncio.to_thread(target.write_bytes, data)
                    csvs.append((method, str(target)))
                try:
                    sha = await scores_export.replace_methods(session, fresh, csvs, body.removed)
                except Exception as e:
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
        if not sha:
            return None
        return await asyncio.to_thread(
            scores_service.build_index, mp_id, str(blob_store.path_for(sha))
        )

    # Hundreds of MB per method: past `deferred.WAIT_SECONDS` the pull goes on as
    # a job (core/deferred).
    return await deferred.respond(
        user.id, work, deferred.AsJob("Pull similarity scores", workspace_id=workspace_id, lane="heavy_query"),
    )


@router.post(
    "/mapping-projects/{mapping_project_id}/set-sync-state",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def mapping_project_set_sync_state(
    mapping_project_id: str,
    body: GitSetSyncStateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Anchor the entity's sync state to a known remote commit — called right after
    a git import so the freshly-created project has a base to compare against (a
    later push elsewhere is then detected as 'behind'). Write access required."""
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:write"
    )
    await _apply_sync_state(db, "mapping-projects", mp.id, body)


@router.post(
    "/mapping-projects/{mapping_project_id}/commit-push",
    response_model=GitCommitResponse,
)
async def mapping_project_commit_push(
    mapping_project_id: str,
    file: UploadFile | None = File(None),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:write"
    )
    if _remote_url(mp) is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Mapping project is not linked to a git remote"
        )
    await _refuse_direct_push(db, mp.workspace_id)
    resolved_branch = _default_branch(mp, branch)
    row = await git_sync_state_service.get(
        db, "mapping-projects", mp.id, resolved_branch
    )
    return await _pushed(
        user,
        deferred.AsJob("Git push", workspace_id=mp.workspace_id),
        git_service.commit_push(
            git_service.mapping_project_repo_getter,
            mp.id,
            await _mapping_project_zip_bytes(db, mp, file),
            resolved_branch,
            message,
            _remote_url(mp),
            await _token(db, user, mp),
            paths,
            *_push_anchors(row),
        ),
        ("mapping-projects", mp.id, resolved_branch),
    )


# --- SQL script collection scope ------------------------------------------


async def _load_sql_collection(
    collection_id: str, db: AsyncSession, user: User, permission: str
):
    from app.core.permissions import check_workspace_permission
    from app.services import sql_script_service

    collection = await sql_script_service.get(db, collection_id)
    if collection is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "SQL script collection not found"
        )
    await check_workspace_permission(db, collection.workspace_id, user, permission)
    return collection


@router.post(
    "/sql-script-collections/{collection_id}/status", response_model=GitStatusResponse
)
async def sql_collection_status(
    collection_id: str,
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    file = await _writer_upload(file, _workspace_writer(db, c.workspace_id, user, "sql-scripts:write"))
    result = await _guard(
        git_service.status(
            git_service.sql_collection_repo_getter,
            c.id,
            await _sql_collection_zip_bytes(db, c, file),
            _default_branch(c, branch),
            _remote_url(c),
            await _token(db, user, c),
        )
    )
    return {"linked": _remote_url(c) is not None, **result}


@router.post(
    "/sql-script-collections/{collection_id}/diff", response_model=GitDiffResponse
)
async def sql_collection_diff(
    collection_id: str,
    file: UploadFile | None = File(None),
    path: str = Form(...),
    branch: str | None = Form(None),
    # Set by the client for a renamed file: HEAD only knows it under this name.
    old_path: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    file = await _writer_upload(file, _workspace_writer(db, c.workspace_id, user, "sql-scripts:write"))
    return await _guard(
        git_service.diff(
            git_service.sql_collection_repo_getter,
            c.id,
            await _sql_collection_zip_bytes(db, c, file),
            _default_branch(c, branch),
            path,
            _remote_url(c),
            await _token(db, user, c),
            old_path=old_path,
        )
    )


@router.get(
    "/sql-script-collections/{collection_id}/branches",
    response_model=GitBranchesResponse,
)
async def sql_collection_branches(
    collection_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    return await git_service.branches(
        git_service.sql_collection_repo_getter,
        c.id,
        _remote_url(c),
        await _token(db, user, c),
    )


@router.post(
    "/sql-script-collections/{collection_id}/commit-push",
    response_model=GitCommitResponse,
)
async def sql_collection_commit_push(
    collection_id: str,
    file: UploadFile | None = File(None),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:write")
    if _remote_url(c) is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "SQL script collection is not linked to a git remote",
        )
    await _refuse_direct_push(db, c.workspace_id)
    resolved_branch = _default_branch(c, branch)
    row = await git_sync_state_service.get(db, "sql-script-collections", c.id, resolved_branch)
    return await _pushed(
        user,
        deferred.AsJob("Git push", workspace_id=c.workspace_id),
        git_service.commit_push(
            git_service.sql_collection_repo_getter,
            c.id,
            await _sql_collection_zip_bytes(db, c, file),
            resolved_branch,
            message,
            _remote_url(c),
            await _token(db, user, c),
            paths,
            *_push_anchors(row),
        ),
        ("sql-script-collections", c.id, resolved_branch),
    )


@router.post("/sql-script-collections/{collection_id}/propose", response_model=GitProposalResponse, dependencies=_PROPOSALS)
async def sql_collection_propose(
    collection_id: str,
    title: str = Form(...),
    description: str = Form(""),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    file: UploadFile | None = File(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:write")
    return await _propose(
        db, user, "sql-script-collections", c.id, git_service.sql_collection_repo_getter,
        await _sql_collection_zip_bytes(db, c, file), _default_branch(c, branch),
        _remote_url(c), await _token(db, user, c), title, description, paths,
    )


@router.get("/sql-script-collections/{collection_id}/proposals", response_model=list[GitProposalResponse], dependencies=_PROPOSALS)
async def sql_collection_proposals(
    collection_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    return await _proposals(db, "sql-script-collections", c.id, _remote_url(c), await _token(db, user, c))


@router.post("/sql-script-collections/{collection_id}/three-way", response_model=GitThreeWayResponse)
async def sql_collection_three_way(
    collection_id: str,
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    file = await _writer_upload(file, _workspace_writer(db, c.workspace_id, user, "sql-scripts:write"))
    return await _three_way(
        db, "sql-script-collections", c.id, git_service.sql_collection_repo_getter,
        await _sql_collection_zip_bytes(db, c, file), _default_branch(c, branch),
        _remote_url(c), await _token(db, user, c),
    )


@router.post("/sql-script-collections/{collection_id}/merged-tree")
async def sql_collection_merged_tree(
    collection_id: str,
    remote_head: str = Form(..., alias="remoteHead"),
    overrides: str = Form("{}"),
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    file = await _writer_upload(file, _workspace_writer(db, c.workspace_id, user, "sql-scripts:write"))
    return await _merged_tree(
        git_service.sql_collection_repo_getter, c.id, await _sql_collection_zip_bytes(db, c, file),
        _default_branch(c, branch), _remote_url(c), await _token(db, user, c), remote_head, overrides,
    )


@router.get(
    "/sql-script-collections/{collection_id}/sync-state",
    response_model=GitSyncStateResponse,
)
async def sql_collection_sync_state(
    collection_id: str,
    branch: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    return await _sync_state(
        db, "sql-script-collections", git_service.sql_collection_repo_getter, c.id,
        _default_branch(c, branch), _remote_url(c), await _token(db, user, c),
    )


@router.post(
    "/sql-script-collections/{collection_id}/set-sync-state",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def sql_collection_set_sync_state(
    collection_id: str,
    body: GitSetSyncStateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:write")
    await _apply_sync_state(db, "sql-script-collections", c.id, body)


# --- Workspace-scoped entities (ETL / catalog / DQ / plugins / schema presets) ---
#
# These five share the SQL-collection shape exactly: one repo per entity, a
# service.get() loader, a workspace-permission check, and the four generic git
# ops. Rather than repeat ~90 lines each, a small factory registers the routes
# from a per-entity spec (loader + repo getter + read/write permission strings).


async def _load_workspace_entity(get_fn, entity_id, db, user, permission, not_found):
    from app.core.permissions import check_workspace_permission

    entity = await get_fn(db, entity_id)
    if entity is None:
        # The id is half the diagnosis: "not found" alone cannot tell a deleted
        # entity from a stale link pointing at an id this instance never had.
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{not_found} (id: {entity_id})")
    if entity.workspace_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"{not_found} has no workspace (id: {entity_id})"
        )
    await check_workspace_permission(db, entity.workspace_id, user, permission)
    return entity


def _register_entity_git_routes(
    *, prefix, get_fn, repo_getter, read_perm, write_perm, not_found, assemble_fn=None
):
    """Add status/diff/branches/commit-push for a workspace-scoped entity.

    ``assemble_fn(db, entity) -> bytes`` builds the export ZIP server-side when the
    client sends no file (the fullstack path that offloads the browser), mirroring
    project/mapping/workspace. When absent, a file upload is required (front-only)."""

    async def _zip_bytes(db, e, file: UploadFile | None) -> bytes:
        if file is not None:
            return await file.read()
        if assemble_fn is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "no export file provided"
            )
        return await _assembled(assemble_fn(db, e), prefix)

    @router.post(
        f"/{prefix}/{{entity_id}}/status",
        response_model=GitStatusResponse,
        name=f"{prefix}_status",
    )
    async def _status(
        entity_id: str,
        file: UploadFile | None = File(None),
        branch: str | None = Form(None),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(
            get_fn, entity_id, db, user, read_perm, not_found
        )
        file = await _writer_upload(file, _workspace_writer(db, e.workspace_id, user, write_perm))
        result = await _guard(
            git_service.status(
                repo_getter,
                _entity_id(e),
                await _zip_bytes(db, e, file),
                _default_branch(e, branch),
                _remote_url(e),
                await _token(db, user, e),
            )
        )
        return {"linked": _remote_url(e) is not None, **result}

    @router.post(
        f"/{prefix}/{{entity_id}}/diff",
        response_model=GitDiffResponse,
        name=f"{prefix}_diff",
    )
    async def _diff(
        entity_id: str,
        file: UploadFile | None = File(None),
        path: str = Form(...),
        branch: str | None = Form(None),
        # Set by the client for a renamed file: HEAD only knows it under this name.
        old_path: str | None = Form(None),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(
            get_fn, entity_id, db, user, read_perm, not_found
        )
        file = await _writer_upload(file, _workspace_writer(db, e.workspace_id, user, write_perm))
        return await _guard(
            git_service.diff(
                repo_getter,
                _entity_id(e),
                await _zip_bytes(db, e, file),
                _default_branch(e, branch),
                path,
                _remote_url(e),
                await _token(db, user, e),
                old_path=old_path,
            )
        )

    @router.get(
        f"/{prefix}/{{entity_id}}/branches",
        response_model=GitBranchesResponse,
        name=f"{prefix}_branches",
    )
    async def _branches(
        entity_id: str,
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(
            get_fn, entity_id, db, user, read_perm, not_found
        )
        return await git_service.branches(
            repo_getter, _entity_id(e), _remote_url(e), await _token(db, user, e)
        )

    @router.post(
        f"/{prefix}/{{entity_id}}/commit-push",
        response_model=GitCommitResponse,
        name=f"{prefix}_commit_push",
    )
    async def _commit_push(
        entity_id: str,
        file: UploadFile | None = File(None),
        message: str = Form(...),
        branch: str | None = Form(None),
        paths: list[str] | None = Form(None),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(
            get_fn, entity_id, db, user, write_perm, not_found
        )
        if _remote_url(e) is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"{not_found} is not linked to a git remote",
            )
        await _refuse_direct_push(db, e.workspace_id)
        resolved_branch = _default_branch(e, branch)
        # Pass the anchor so git_service refuses a push over remote work the user
        # hasn't pulled ("pull first"). Without it the guard is inert and a stale
        # push silently fast-forwards over someone else's commits.
        row = await git_sync_state_service.get(db, prefix, _entity_id(e), resolved_branch)
        return await _pushed(
            user,
            deferred.AsJob("Git push", workspace_id=e.workspace_id),
            git_service.commit_push(
                repo_getter,
                _entity_id(e),
                await _zip_bytes(db, e, file),
                resolved_branch,
                message,
                _remote_url(e),
                await _token(db, user, e),
                paths,
                *_push_anchors(row),
            ),
            (prefix, _entity_id(e), resolved_branch),
        )

    @router.post(f"/{prefix}/{{entity_id}}/propose", response_model=GitProposalResponse, name=f"{prefix}_propose", dependencies=_PROPOSALS)
    async def _propose_route(
        entity_id: str,
        title: str = Form(...),
        description: str = Form(""),
        branch: str | None = Form(None),
        paths: list[str] | None = Form(None),
        file: UploadFile | None = File(None),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(get_fn, entity_id, db, user, write_perm, not_found)
        return await _propose(
            db, user, prefix, _entity_id(e), repo_getter, await _zip_bytes(db, e, file),
            _default_branch(e, branch), _remote_url(e), await _token(db, user, e), title, description, paths,
        )

    @router.get(f"/{prefix}/{{entity_id}}/proposals", response_model=list[GitProposalResponse], name=f"{prefix}_proposals", dependencies=_PROPOSALS)
    async def _proposals_route(
        entity_id: str,
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(get_fn, entity_id, db, user, read_perm, not_found)
        return await _proposals(db, prefix, _entity_id(e), _remote_url(e), await _token(db, user, e))

    @router.post(
        f"/{prefix}/{{entity_id}}/three-way",
        response_model=GitThreeWayResponse,
        name=f"{prefix}_three_way",
    )
    async def _three_way_route(
        entity_id: str,
        file: UploadFile | None = File(None),
        branch: str | None = Form(None),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(get_fn, entity_id, db, user, read_perm, not_found)
        file = await _writer_upload(file, _workspace_writer(db, e.workspace_id, user, write_perm))
        return await _three_way(
            db, prefix, _entity_id(e), repo_getter, await _zip_bytes(db, e, file),
            _default_branch(e, branch), _remote_url(e), await _token(db, user, e),
        )

    @router.post(f"/{prefix}/{{entity_id}}/merged-tree", name=f"{prefix}_merged_tree")
    async def _merged_tree_route(
        entity_id: str,
        remote_head: str = Form(..., alias="remoteHead"),
        overrides: str = Form("{}"),
        file: UploadFile | None = File(None),
        branch: str | None = Form(None),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(get_fn, entity_id, db, user, read_perm, not_found)
        file = await _writer_upload(file, _workspace_writer(db, e.workspace_id, user, write_perm))
        return await _merged_tree(
            repo_getter, _entity_id(e), await _zip_bytes(db, e, file), _default_branch(e, branch),
            _remote_url(e), await _token(db, user, e), remote_head, overrides,
        )

    @router.get(
        f"/{prefix}/{{entity_id}}/sync-state",
        response_model=GitSyncStateResponse,
        name=f"{prefix}_sync_state",
    )
    async def _sync_state_route(
        entity_id: str,
        branch: str | None = None,
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        """Where the local entity stands vs the remote branch (behind/diverged),
        from the DB anchor. No ZIP: the check only compares remote oids, so the
        client needn't rebuild the export just to learn it is out of date."""
        e = await _load_workspace_entity(
            get_fn, entity_id, db, user, read_perm, not_found
        )
        return await _sync_state(
            db,
            prefix,
            repo_getter,
            _entity_id(e),
            _default_branch(e, branch),
            _remote_url(e),
            await _token(db, user, e),
        )

    @router.post(
        f"/{prefix}/{{entity_id}}/set-sync-state",
        status_code=status.HTTP_204_NO_CONTENT,
        name=f"{prefix}_set_sync_state",
    )
    async def _set_sync_state_route(
        entity_id: str,
        body: GitSetSyncStateRequest,
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        """Anchor the entity to a known remote commit — called after a git import
        or a pull so later remote work is detected as 'behind'. Write access."""
        e = await _load_workspace_entity(
            get_fn, entity_id, db, user, write_perm, not_found
        )
        await _apply_sync_state(db, prefix, _entity_id(e), body)


def _entity_id(entity):
    """The repo key — `id` on every entity, schema presets included since their
    key moved there (revision e6f7a8b9c0d1)."""
    return entity.id


def _register_all_entity_git_routes() -> None:
    from app.services import (
        data_catalog_service,
        data_source_service,
        dq_rule_set_service,
        etl_pipeline_service,
        schema_preset_service,
        user_plugin_service,
    )
    from app.services.workspace_export_assemble import (
        assemble_data_catalog_zip,
        assemble_database_zip,
        assemble_dq_rule_set_zip,
        assemble_etl_pipeline_zip,
        assemble_schema_preset_zip,
        assemble_user_plugin_zip,
    )

    _register_entity_git_routes(
        prefix="etl-pipelines",
        get_fn=etl_pipeline_service.get,
        repo_getter=git_service.etl_pipeline_repo_getter,
        read_perm="etl:read",
        write_perm="etl:write",
        not_found="ETL pipeline not found",
        assemble_fn=assemble_etl_pipeline_zip,
    )
    _register_entity_git_routes(
        prefix="data-catalogs",
        get_fn=data_catalog_service.get,
        repo_getter=git_service.data_catalog_repo_getter,
        read_perm="catalog:read",
        write_perm="catalog:write",
        not_found="Data catalog not found",
        assemble_fn=assemble_data_catalog_zip,
    )
    _register_entity_git_routes(
        prefix="dq-rule-sets",
        get_fn=dq_rule_set_service.get,
        repo_getter=git_service.dq_rule_set_repo_getter,
        read_perm="data-quality:read",
        write_perm="data-quality:write",
        not_found="DQ rule set not found",
        assemble_fn=assemble_dq_rule_set_zip,
    )
    _register_entity_git_routes(
        prefix="user-plugins",
        get_fn=user_plugin_service.get,
        repo_getter=git_service.user_plugin_repo_getter,
        read_perm="plugins:read",
        write_perm="plugins:write",
        not_found="Plugin not found",
        assemble_fn=assemble_user_plugin_zip,
    )
    _register_entity_git_routes(
        prefix="schema-presets",
        get_fn=schema_preset_service.get,
        repo_getter=git_service.schema_preset_repo_getter,
        read_perm="schemas:read",
        write_perm="schemas:write",
        not_found="Schema preset not found",
        assemble_fn=assemble_schema_preset_zip,
    )
    _register_entity_git_routes(
        prefix="databases",
        get_fn=data_source_service.get,
        repo_getter=git_service.data_source_repo_getter,
        read_perm="databases:read",
        write_perm="databases:write",
        not_found="Database not found",
        assemble_fn=assemble_database_zip,
    )


_register_all_entity_git_routes()


# --- Verify + Clone (no entity, just authenticated) -----------------------


async def _check_may_fetch(db: AsyncSession, user: User, workspace_id: str | None) -> None:
    """Fetching a remote makes the server open a connection a user chose: only
    for someone who can write something in the workspace the content is for, or
    create a workspace when the repo is one."""
    if workspace_id is None:
        allowed = await has_global_permission(db, user, "workspaces:write")
    else:
        perms = await effective_workspace_permissions(db, workspace_id, user)
        allowed = any(p.endswith(":write") for p in perms)
    if not allowed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions")


async def _check_may_fetch_for_some_workspace(db: AsyncSession, user: User) -> None:
    """`_check_may_fetch` for a read tied to no workspace yet (a catalog index,
    browsed before choosing where to install): whoever could install somewhere."""
    if await has_global_permission(db, user, "workspaces:write"):
        return
    for workspace in await workspace_service.list_for_user(db, user):
        perms = await effective_workspace_permissions(db, workspace.id, user)
        if any(p.endswith(":write") for p in perms):
            return
    raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions")


@router.post("/verify-remote", response_model=GitVerifyResponse)
async def verify_remote(
    body: GitVerifyRequest,
    purpose: Literal["catalog"] | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Check a remote is reachable with the given credentials before the caller
    persists the link — so an unreachable/unauthorized URL is rejected up front
    instead of silently saved and only failing later in the sync panel. On
    success, remember the token for this user + host so the token-less sync ops
    (status/diff/commit-push) can use it afterwards.

    `purpose=catalog` checks a catalog source, which is tied to no workspace:
    allowed for whoever may read its index (`/catalog-file`)."""
    if purpose == "catalog":
        await _check_may_fetch_for_some_workspace(db, user)
    else:
        await _check_may_fetch(db, user, body.workspace_id)
    try:
        result = await git_service.verify_remote(body.url, body.token)
    except git_service.GitError as exc:
        raise _git_http_error(exc) from exc
    if body.token:
        await git_credential_service.set_token_for_url(db, user, body.url, body.token)
    return result


@router.post("/clone")
async def clone(
    body: GitCloneRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Shallow-clone a remote server-side and stream back its content as a ZIP,
    so the import flow works without an in-browser CORS proxy. A token used here
    is remembered for this user + host so later sync ops find it."""
    from fastapi.responses import Response

    await _check_may_fetch(db, user, body.workspace_id)
    # Fall back to the user's stored (user, host) token when the request carries
    # none — so a retry clone of a private repo (the card's "content not imported"
    # button, which has no token to hand) reuses the token saved at first import.
    token = body.token or await git_credential_service.token_for_url(db, user, body.url)

    async def work() -> Response:
        try:
            data, cloned_oid = await git_service.clone_to_zip(
                body.url, body.branch or "main", token
            )
        except git_service.GitError as exc:
            raise _git_http_error(exc) from exc
        if body.token:
            async with deferred.session() as session:
                await git_credential_service.set_token_for_url(session, user, body.url, body.token)
        audit.bind(action="download", workspace_id=body.workspace_id,
                   detail=f"git clone {_without_credentials(body.url)} ({len(data)} bytes)")
        headers = {"Content-Disposition": 'attachment; filename="repo.zip"'}
        # The cloned HEAD, so the import and pull flows can anchor the entity's sync
        # state to it. Exposing it to JS is CORSMiddleware's job (expose_headers in
        # main.py): setting Access-Control-Expose-Headers here does nothing, because the
        # middleware overwrites it with its own list on the way out — which is exactly
        # how this header stayed unreadable, leaving every pull unanchored.
        if cloned_oid:
            headers["X-Git-Cloned-Oid"] = cloned_oid
        return Response(content=data, media_type="application/zip", headers=headers)

    # A repository with LFS data takes minutes: past `deferred.WAIT_SECONDS` the
    # clone goes on as a job (core/deferred), its ZIP handed to the poll.
    return await deferred.respond(
        user.id, work, deferred.AsJob(f"Git clone {_without_credentials(body.url)}", workspace_id=body.workspace_id),
    )


def _without_credentials(url: str) -> str:
    """`url` without its userinfo, query or fragment — a token can sit in any of them."""
    parts = urlsplit(url)
    return urlunsplit(parts._replace(netloc=parts.netloc.rsplit("@", 1)[-1], query="", fragment=""))


# --- Per-user host token management ---------------------------------------


@router.put("/host-token", response_model=GitHostTokenStatus)
async def set_host_token(
    body: GitHostTokenRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Store (or clear, when the token is empty) the acting user's access token
    for the host of `url`. The token is encrypted at rest and reused for every
    repo on that host; it is never returned by the API."""
    host = git_credential_service.host_of(body.url)
    if not host:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Could not determine host from URL")
    await git_credential_service.set_token(db, user, host, body.token)
    return {"host": host, "has_token": bool(body.token)}


@router.get("/host-token", response_model=GitHostTokenStatus)
async def get_host_token_status(
    url: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Whether the acting user has a token stored for the host of `url` (the token
    itself is never returned — only its presence)."""
    host = git_credential_service.host_of(url)
    if not host:
        return {"host": None, "has_token": False}
    return {"host": host, "has_token": await git_credential_service.has_token_for_host(db, user, host)}


@router.get("/catalog-file")
async def get_catalog_file(
    url: str,
    file: str,
    branch: str = "main",
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """A private catalog's index file, read with the acting user's token for its host.

    Failures answer 502 with `{code}` (the client's CatalogFetchError kind) rather
    than the upstream status: a 401 here would read as the user's own session expiring.
    """
    from fastapi.responses import Response

    await _check_may_fetch_for_some_workspace(db, user)
    token = await git_credential_service.token_for_url(db, user, url)
    try:
        data = await catalog_remote_service.fetch_file(url, branch, file, token)
    except catalog_remote_service.CatalogFetchError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, {"code": exc.kind}) from exc
    audit.bind(action="download", detail=f"git catalog file {_without_credentials(url)} {file} ({len(data)} bytes)")
    return Response(content=data, media_type="application/json")


# --- Settings scope (account-level: organizations + users + roles) --------
#
# Unlike the other scopes this one is not workspace-membership gated — it manages
# accounts, so it requires the global admin. The "entity" is the app_settings
# singleton, addressed as /git/settings/account/... so it slots into the same
# generic client (scope="settings", id="account") that drives the shared
# GitRepositoryTab + GitSyncPanel. The server always BUILDS the full export tree
# (organizations + users + roles); which files to push is chosen in the panel
# (per-file selection / quick actions), like every other scope.

SETTINGS_ID = "settings/account"


async def _settings_remote(db: AsyncSession) -> str | None:
    row = await app_settings_service.get_or_create(db)
    cfg = row.git_remote_config or {}
    return cfg.get("url") or None


async def _settings_branch(db: AsyncSession, fallback: str | None) -> str:
    if fallback:
        return fallback
    row = await app_settings_service.get_or_create(db)
    cfg = row.git_remote_config or {}
    return cfg.get("branch") or "main"


async def _settings_token(db: AsyncSession, user: User) -> str | None:
    return await git_credential_service.token_for_url(db, user, await _settings_remote(db))


@router.get("/settings/account/config", response_model=SettingsGitConfigResponse)
async def settings_git_config(
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    row = await app_settings_service.get_or_create(db)
    cfg = row.git_remote_config or {}
    return {"url": cfg.get("url"), "branch": cfg.get("branch")}


@router.put("/settings/account/config", response_model=SettingsGitConfigResponse)
async def set_settings_git_config(
    body: SettingsGitConfig,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Set the settings-scope git remote. The token (if any) is stripped and stored
    per (user, host); only {url, branch} is persisted and returned."""
    payload = {"url": body.url, "branch": body.branch}
    if body.auth_token:
        payload["authToken"] = body.auth_token
    row, token = await app_settings_service.set_git_remote_config(
        db, payload if body.url else None
    )
    if token and body.url:
        await git_credential_service.set_token_for_url(db, admin, body.url, token)
    cfg = row.git_remote_config or {}
    return {"url": cfg.get("url"), "branch": cfg.get("branch")}


@router.post("/settings/account/status", response_model=GitStatusResponse)
async def settings_status(
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    remote = await _settings_remote(db)
    result = await _guard(
        git_service.status(
            git_service.settings_repo_getter,
            SETTINGS_ID,
            await _assembled(assemble_settings_zip(db, SettingsSelection()), "settings"),
            await _settings_branch(db, branch),
            remote,
            await _settings_token(db, user),
        )
    )
    return {"linked": remote is not None, **result}


@router.post("/settings/account/diff", response_model=GitDiffResponse)
async def settings_diff(
    file: UploadFile | None = File(None),
    path: str = Form(...),
    branch: str | None = Form(None),
    # Set by the client for a renamed file: HEAD only knows it under this name.
    old_path: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    return await _guard(
        git_service.diff(
            git_service.settings_repo_getter,
            SETTINGS_ID,
            await _assembled(assemble_settings_zip(db, SettingsSelection()), "settings"),
            await _settings_branch(db, branch),
            path,
            await _settings_remote(db),
            await _settings_token(db, user),
            old_path=old_path,
        )
    )


@router.get("/settings/account/branches", response_model=GitBranchesResponse)
async def settings_branches(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    return await git_service.branches(
        git_service.settings_repo_getter,
        SETTINGS_ID,
        await _settings_remote(db),
        await _settings_token(db, user),
    )


@router.get("/settings/account/sync-state", response_model=GitSyncStateResponse)
async def settings_sync_state(
    branch: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    return await _sync_state(
        db,
        "settings",
        git_service.settings_repo_getter,
        SETTINGS_ID,
        await _settings_branch(db, branch),
        await _settings_remote(db),
        await _settings_token(db, user),
    )


@router.post("/settings/account/commit-push", response_model=GitCommitResponse)
async def settings_commit_push(
    file: UploadFile | None = File(None),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    remote = await _settings_remote(db)
    if remote is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Settings are not linked to a git remote"
        )
    resolved_branch = await _settings_branch(db, branch)
    row = await git_sync_state_service.get(db, "settings", SETTINGS_ID, resolved_branch)
    return await _pushed(
        user,
        None,
        git_service.commit_push(
            git_service.settings_repo_getter,
            SETTINGS_ID,
            await _assembled(assemble_settings_zip(db, SettingsSelection()), "settings"),
            resolved_branch,
            message,
            remote,
            await _settings_token(db, user),
            paths,
            *_push_anchors(row),
        ),
        ("settings", SETTINGS_ID, resolved_branch),
    )


@router.post("/settings/account/propose", response_model=GitProposalResponse, dependencies=_PROPOSALS)
async def settings_propose(
    title: str = Form(...),
    description: str = Form(""),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    return await _propose(
        db, user, "settings", SETTINGS_ID, git_service.settings_repo_getter,
        await _assembled(assemble_settings_zip(db, SettingsSelection()), "settings"),
        await _settings_branch(db, branch), await _settings_remote(db), await _settings_token(db, user),
        title, description, paths,
    )


@router.get("/settings/account/proposals", response_model=list[GitProposalResponse], dependencies=_PROPOSALS)
async def settings_proposals(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    return await _proposals(db, "settings", SETTINGS_ID, await _settings_remote(db), await _settings_token(db, user))


@router.post("/settings/account/three-way", response_model=GitThreeWayResponse)
async def settings_three_way(
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    return await _three_way(
        db, "settings", SETTINGS_ID, git_service.settings_repo_getter,
        await _assembled(assemble_settings_zip(db, SettingsSelection()), "settings"),
        await _settings_branch(db, branch), await _settings_remote(db), await _settings_token(db, user),
    )


@router.post("/settings/account/merged-tree")
async def settings_merged_tree(
    remote_head: str = Form(..., alias="remoteHead"),
    overrides: str = Form("{}"),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    return await _merged_tree(
        git_service.settings_repo_getter, SETTINGS_ID,
        await _assembled(assemble_settings_zip(db, SettingsSelection()), "settings"),
        await _settings_branch(db, branch), await _settings_remote(db), await _settings_token(db, user),
        remote_head, overrides,
    )


@router.post("/settings/account/set-sync-state", status_code=status.HTTP_204_NO_CONTENT)
async def settings_set_sync_state(
    body: GitSetSyncStateRequest,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    await _apply_sync_state(db, "settings", SETTINGS_ID, body)


_SETTINGS_ZIP_MAX_BYTES = 64 * 1024 * 1024


async def _apply_settings_zip(
    db: AsyncSession,
    zip_bytes: bytes,
    acting_username: str | None,
) -> SettingsImportResponse:
    try:
        tree = await asyncio.to_thread(git_service.read_archive, zip_bytes, _SETTINGS_ZIP_MAX_BYTES)
    except git_service.GitError as exc:
        raise _git_http_error(exc) from exc
    report = await settings_import_service.import_settings_tree(db, tree, acting_username)
    return SettingsImportResponse(**report.as_dict())


@router.get("/settings/account/export")
async def settings_export_zip(
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Download the settings export as a ZIP (organizations + users + roles, no
    passwords) — the offline/manual counterpart to git push."""
    from fastapi.responses import Response

    data = await assemble_settings_zip(db, SettingsSelection())
    audit.bind(action="export", detail=f"settings export ({len(data)} bytes)")
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="settings.zip"'},
    )


@router.post("/settings/account/import-file", response_model=SettingsImportResponse)
async def settings_import_file(
    file: UploadFile = File(...),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Upload a settings ZIP (organizations/users/roles) and upsert it. New users
    land disabled (no password). Only the files present in the ZIP are applied."""
    return await _apply_settings_zip(db, await file.read(), admin.username)


# --- Git-linked content reconstitution status (badge + retry) --------------


@router.get(
    "/workspaces/{workspace_id}/content-status",
    response_model=list[GitContentStatusEntry],
)
async def workspace_content_status(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    """The git-linked entities in this workspace whose content is not yet
    reconstituted (pending clone, or failed) — so the UI can badge their cards."""
    rows = await git_content_status_service.list_for_workspace(db, workspace_id)
    return [
        GitContentStatusEntry(scope=r.scope, entity_id=r.entity_id, status=r.status)
        for r in rows
    ]


@router.put(
    "/workspaces/{workspace_id}/content-status",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def set_workspace_content_status(
    workspace_id: str,
    body: GitContentStatusUpdate,
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:write")),
):
    """Mark a git-linked entity's content as pending/failed (set at import, updated
    on a failed retry)."""
    await git_content_status_service.set_status(
        db, body.scope, body.entity_id, workspace_id, body.status
    )


@router.delete(
    "/workspaces/{workspace_id}/content-status/{scope}/{entity_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def clear_workspace_content_status(
    workspace_id: str,
    scope: str,
    entity_id: str,
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:write")),
):
    """Clear the status once the entity's content is reconstituted (successful clone)."""
    await git_content_status_service.clear(db, workspace_id, scope, entity_id)
