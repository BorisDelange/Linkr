import asyncio
import uuid

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, status
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocketDisconnect

from app.core import audit
from app.config import settings
from app.core.database import async_session, get_db
from app.core.deps import get_current_user
from app.core.security import create_kernel_token
from app.core.permissions import (
    check_project_permission,
    check_workspace_permission,
    has_project_permission,
)
from app.core.ws_auth import WS_AUTH_FAILED, WS_FORBIDDEN, authenticate_ws, refuse, watch_credentials
from app.models.project import Project
from app.models.user import User
from app.schemas.execution import (
    CompleteRequest,
    CompletionItem,
    ExecuteRequest,
    ExecuteResponse,
    JobResponse,
    PrewarmRequest,
    RenderRequest,
    RestartKernelRequest,
    RuntimeFigureResponse,
)
from app.schemas.execution_session import (
    ExecutionSessionCreate,
    ExecutionSessionResponse,
)
from app.services import (
    code_acceptance_service,
    database_credential_service,
    data_source_service,
    dataset_service,
    execution_session_service,
    project_fs,
)
from app.services.data import dataset_fs
from app.services.execution import completion, environments, injection, kernel, pty_kernel, render, runtime

logger = structlog.get_logger()

router = APIRouter(prefix="/execute", tags=["execution"])

# How often an open terminal re-checks the session that opened it.
TERMINAL_AUTH_RECHECK_SECONDS = 30.0


async def _require_project_access(
    db: AsyncSession, project_uid: str, user: User, permission: str
) -> None:
    """Reading a project's kernels/sessions needs the matching IDE permission
    (inherited workspace role + per-project override) — mirrors ide_files."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_permission(db, project, user, permission)


async def _require_code_execution(
    db: AsyncSession, project_uid: str, user: User
) -> None:
    """Running code / attaching a terminal requires the ide:execute permission on
    the project (granted to editor+ by default, but separable so an admin can allow
    read-everything without letting a role run server-side code)."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if not await has_project_permission(db, project, user, "ide:execute"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Code execution not permitted on this project"
        )
    project_fs.prime_binding(project_uid, project.ide_path, project.scripts_path, project.datasets_path)


# The "purpose" of an /execute call → the resource permission it needs ON TOP of
# ide:execute. /execute runs the client's `code` verbatim, so it is free-form code
# whatever the purpose says: the widget :execute permission is an extra check,
# never a substitute for ide:execute.
# "render" is NOT here: built-in component renders carry no free-form code and go
# through POST /execute/render (server-owned program); it is refused on /execute.
_PURPOSE_PERMISSION = {
    "ide": "ide:execute",
    "dashboards": "dashboards:execute",
    "datasets": "datasets:execute",
    "patient-data": "patient-data:execute",
}


async def _require_execute(
    db: AsyncSession, project_uid: str, user: User, purpose: str
) -> None:
    """Enforce ide:execute, plus the permission for this run's `purpose`, on the project."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    # A built-in component render must go through POST /execute/render (server-owned
    # code from a spec). It is REFUSED here: /execute runs the client's `code`
    # verbatim, so letting purpose="render" downgrade the gate to viewer would let a
    # viewer run arbitrary code. Renders are viewer-visible only via the spec path.
    if purpose == "render":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "purpose='render' must use POST /execute/render (no free-form code)",
        )
    # Instance-wide kill switch: when code execution is disabled, no free-form run
    # is allowed regardless of permission (matches the terminal WS / env routes).
    if not settings.enable_code_execution:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Code execution is disabled on this instance"
        )
    for permission in dict.fromkeys(("ide:execute", _PURPOSE_PERMISSION.get(purpose, "ide:execute"))):
        if not await has_project_permission(db, project, user, permission):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Code execution not permitted on this project"
            )
    project_fs.prime_binding(project_uid, project.ide_path, project.scripts_path, project.datasets_path)


async def _require_connection_access(
    db: AsyncSession, connection_id: str, user: User
):
    """Load a data source only if the user may read its workspace. Returns the
    source (guarding sql_query() from reaching an arbitrary connection)."""
    source = await data_source_service.get(db, connection_id)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
    await check_workspace_permission(db, source.workspace_id, user, "databases:read")
    return source


async def _dataset_preamble(
    db: AsyncSession,
    dataset_ref: str,
    language: str,
    filters: list[dict] | None,
    project_uid: str | None,
) -> str:
    """Server-side `dataset` injection code for the requested dataset.

    Disk-source mode (project context): `dataset_ref` is the dataset's relative
    path under datasets/; inject from its Parquet cache. Legacy: `dataset_ref` is
    a DB DatasetFile id."""
    if project_uid:
        try:
            # resolve_cache is synchronous and can parse a multi-second CSV/XLSX on a
            # cold cache — run it off the event loop so concurrent widget runs don't
            # serialise behind one another (they'd otherwise all wait on this call).
            res = await asyncio.to_thread(dataset_fs.resolve_cache, project_uid, dataset_ref)
        except FileNotFoundError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
        path = res["parquet"].as_posix()
        columns = res["columns"]
        native = bool(res.get("native"))
        return (
            injection.python_preamble_from(path, columns, filters, native)
            if language == "python"
            else injection.r_preamble_from(path, columns, filters, native)
        )
    node = await dataset_service.get(db, dataset_ref)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
    return (
        injection.python_preamble(node, filters)
        if language == "python"
        else injection.r_preamble(node, filters)
    )


def _with_context(body: ExecuteRequest) -> str:
    if not body.context_vars:
        return body.code
    try:
        return injection.context_preamble(body.language, body.context_vars) + body.code
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))


@router.post("", response_model=ExecuteResponse)
async def execute_code(
    body: ExecuteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run R/Python server-side and return the captured output.

    Only the rendered result crosses the wire (stdout/stderr/figures/table) —
    never the underlying data (see storage plan §03/§06)."""
    # Every run happens inside a project the caller may edit. Context-less
    # execution is refused: it would let any authenticated account run arbitrary
    # code server-side with no workspace/project scope.
    if not body.project_uid:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "project_uid is required to run code"
        )
    # ide:execute always, plus the resource :execute matching this run's purpose.
    await _require_execute(db, body.project_uid, user, body.purpose)
    await code_acceptance_service.require_accepted(db, user, body.purpose, body.code)
    audit.bind(action="run_code", project_uid=body.project_uid, detail=body.code)

    code = _with_context(body)
    if body.dataset_file_id and body.language in ("python", "r"):
        preamble = await _dataset_preamble(
            db, body.dataset_file_id, body.language, body.dataset_filters, body.project_uid
        )
        code = preamble + "\n" + code

    # sql_query() in the kernel routes back here; the host runs the SQL against the
    # connection's source so the connection config never reaches the kernel.
    resolver = None
    if body.connection_id:
        source = await _require_connection_access(db, body.connection_id, user)
        login = await database_credential_service.resolve_login(db, source, user.id)

        async def resolver(sql: str):
            # Its own session: the request's is released before the run.
            with audit.event_scope():
                async with async_session() as query_db:
                    return await data_source_service.query(query_db, source, login, sql)

    if body.language not in ("python", "r"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unsupported language: {body.language}",
        )
    # Written before the code runs: the line at the end of the request does not
    # exist if the run takes the process down with it.
    audit.event(action="run_code_start", project_uid=body.project_uid, detail=body.code)
    # Dashboard widgets run ephemeral: a fresh, isolated process from the warm pool
    # so widgets run in parallel (no shared kernel/namespace/lock). Still the
    # project's managed env — the widget's code is user code and needs its packages.
    if body.ephemeral:
        environment = await environments.ensure_ready(
            db, body.project_uid, body.language, user.id
        )
        await db.close()
        return _shape_output(await _run_ephemeral(
            user, body.language, body.project_uid, code, environment, resolver
        ))
    return await _run_in_kernel(db, body.project_uid, user, body.language, body.session_id, code, resolver)


async def _run_ephemeral(user: User, language: str, project_uid: str, code: str, environment, resolver=None):
    """A run in a fresh process, within the caller's share of the slots. The caller
    has released its database session: a run can queue and last for minutes."""
    try:
        async with kernel.ephemeral_shares.slot(user.id):
            return await kernel.run_ephemeral(language, project_uid, code, environment, resolver)
    except kernel.EphemeralBusy as e:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, str(e))
    except runtime.ExecutionError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))


@router.post("/run-as-job", response_model=JobResponse)
async def run_as_job(
    body: ExecuteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run a script server-side as a background job: a FRESH process (batch — no
    session namespace), streamed into the jobs panel and cancellable there. Figures
    and a result table are collected at the end and stored on the job. Returns the
    queued job immediately."""
    if not body.project_uid:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "project_uid is required to run code")
    await _require_execute(db, body.project_uid, user, body.purpose)
    await code_acceptance_service.require_accepted(db, user, body.purpose, body.code)
    if body.language not in ("python", "r"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unsupported language: {body.language}")

    code = _with_context(body)
    if body.dataset_file_id:
        preamble = await _dataset_preamble(
            db, body.dataset_file_id, body.language, body.dataset_filters, body.project_uid
        )
        code = preamble + "\n" + code

    from app.services.execution import run_jobs

    label = body.label or f"Run {environments.language_label(body.language)} script"
    job = await run_jobs.start(db, body.project_uid, user.id, body.language, code, label)
    return JobResponse.model_validate(job, from_attributes=True)


def _kernel_token(user: User, project_uid: str) -> str:
    """The LINKR_TOKEN handed to a kernel/terminal for the R/Python client
    libraries. Minted per spawn, scoped to this user and this project, and
    stamped with how this request authenticated (every auth path names it in the
    audit context) — an unnamed one counts as not a web session."""
    via = audit.actor().get("via") or "unknown"
    return create_kernel_token(user.id, user.username, user.role, project_uid, via=via)


async def _run_in_kernel(
    db: AsyncSession, project_uid: str, user: User, language: str, session_id: str, code: str, resolver,
) -> ExecuteResponse:
    """Run `code` in the caller's persistent kernel for (project, language, session)
    and shape the captured output. Used by the IDE /execute path (persistent
    namespace). Dashboard widgets and built-in renders use the ephemeral path
    (`kernel.run_ephemeral`) instead, for isolated parallel execution."""
    # Auto-build the project env on first run if it declares packages but isn't
    # materialised yet (build is visible as a job); an empty/ready env is instant.
    environment = await environments.ensure_ready(db, project_uid, language, user.id)
    await db.close()
    try:
        try:
            k = await kernel.manager.get(
                project_uid, user.id, language, session_id, environment,
                _kernel_token(user, project_uid), via=audit.actor().get("via"),
            )
        except kernel.KernelLimitReached as e:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, str(e))
        except kernel.KernelSessionForeign as e:
            raise HTTPException(status.HTTP_409_CONFLICT, str(e))
        out = await k.execute(code, query_resolver=resolver)
    except runtime.ExecutionError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))

    return _shape_output(out)


def _shape_output(out) -> ExecuteResponse:
    """Shape a RuntimeOutput into the wire response (figures get stable ids)."""
    return ExecuteResponse(
        stdout=out.stdout,
        stderr=out.stderr,
        figures=[
            RuntimeFigureResponse(id=f"fig-{i}", type=f["type"], data=f["data"], label=f["label"])
            for i, f in enumerate(out.figures)
        ],
        table=out.table,
        html=out.html,
        failed=out.failed,
    )


@router.post("/render", response_model=ExecuteResponse)
async def render_component(
    body: RenderRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run a built-in component's server-side aggregation from a structured spec.

    The server owns the analysis program (per `kind`) and injects only the
    validated spec — no client `code` — so this is a VIEW operation (a viewer may
    see component widgets). Its output can carry a dataset's values, whole rows for
    some kinds: naming a dataset takes a permission that reads it. This replaces the
    old purpose="render" path on /execute, which ran client code under a project gate."""
    if not body.project_uid:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "project_uid is required")
    if not render.is_known_kind(body.kind):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown render kind: {body.kind}")
    project = await db.get(Project, body.project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_permission(db, project, user, "project-summary:read")
    if body.dataset_file_id and not (
        await has_project_permission(db, project, user, "datasets:read")
        or await has_project_permission(db, project, user, "dashboards:read")
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Reading this project's datasets is not permitted")
    # Server-owned, but it still runs an interpreter — honour the instance kill switch.
    if not settings.enable_code_execution:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Code execution is disabled on this instance"
        )

    try:
        analysis_code = render.build_render_code(body.kind, body.spec)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))

    # Renders are Python-only today; the dataset is injected as `dataset` first.
    # Warnings are silenced: every component shows any stderr as the widget's error,
    # and a pandas deprecation notice about the server's own program is not one.
    code = analysis_code
    if body.dataset_file_id:
        preamble = await _dataset_preamble(
            db, body.dataset_file_id, "python", body.dataset_filters, body.project_uid
        )
        code = preamble + "\n" + analysis_code
        audit.bind(
            action="preview", project_uid=body.project_uid,
            detail=f"datasets/{body.dataset_file_id} render {body.kind}",
        )
    code = "import warnings as _linkr_warnings\n_linkr_warnings.simplefilter('ignore')\n" + code
    # Built-in renders run ephemeral (a fresh process from the warm pool) so a page
    # of component widgets renders IN PARALLEL — the old shared __app__ kernel
    # serialised them on its lock. environment=None → the app interpreter
    # (sys.executable, which ships the render deps), never the project's managed env.
    await db.close()
    return _shape_output(await _run_ephemeral(user, "python", body.project_uid, code, None))


@router.post("/prewarm", status_code=status.HTTP_202_ACCEPTED)
async def prewarm_pool(
    body: PrewarmRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Pre-start the warm pool for a project's language (dashboard open) so the
    first widget run/render is import-free. Fire-and-forget. A no-op if execution
    is disabled.

    `app_env` warms the app-interpreter pool used by built-in component renders
    (viewer-visible → gated at project read); otherwise the managed-env pool used
    by code widgets (gated at dashboards:execute)."""
    if body.language not in ("python", "r"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unsupported language: {body.language}")
    if body.app_env:
        project = await db.get(Project, body.project_uid)
        if project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
        await check_project_permission(db, project, user, "project-summary:read")
    else:
        await _require_execute(db, body.project_uid, user, "dashboards")
    if not settings.enable_code_execution:
        return
    # Renders use the app interpreter (environment=None); code widgets the managed env.
    environment = None if body.app_env else await environments.resolve(
        db, body.project_uid, body.language
    )
    await kernel.prewarm(body.language, body.project_uid, environment, body.count)


@router.get("/kernels")
async def list_kernels(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The caller's live kernels for a project (language, env, alive, busy, pid,
    rss, idle) — feeds the IDE footer. Per-user: never exposes others' kernels."""
    await _require_project_access(db, project_uid, user, "ide:read")
    return kernel.manager.list_for_user(project_uid, user.id)


@router.post("/restart", status_code=status.HTTP_204_NO_CONTENT)
async def restart_kernel(
    body: RestartKernelRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Kill the caller's persistent kernel for (project, language, session) so the
    next run starts with a clean namespace."""
    await _require_code_execution(db, body.project_uid, user)
    try:
        await kernel.manager.restart(
            body.project_uid, user.id, body.language, body.session_id, via=audit.actor().get("via"),
        )
    except kernel.KernelSessionForeign as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e))


@router.post("/complete", response_model=list[CompletionItem])
async def complete_code(
    body: CompleteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Completions at the cursor for the IDE editor, from the caller's live kernel
    for (project, language, session) — never started for this. Python falls back
    to static analysis of the text when no kernel is running or it is busy."""
    await _require_code_execution(db, body.project_uid, user)
    live = kernel.manager.peek(
        body.project_uid, user.id, body.language, body.session_id, via=audit.actor().get("via")
    )
    return await completion.complete(live, body.language, body.code, body.cursor)


@router.post("/interrupt", status_code=status.HTTP_204_NO_CONTENT)
async def interrupt_kernel(
    body: RestartKernelRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """SIGINT the caller's running kernel for (project, language, session) — the
    Stop button. Unlike restart it keeps the namespace; it just interrupts the
    current run (e.g. a long Sys.sleep). A no-op if nothing is running."""
    await _require_code_execution(db, body.project_uid, user)
    try:
        kernel.manager.interrupt(
            body.project_uid, user.id, body.language, body.session_id, via=audit.actor().get("via"),
        )
    except kernel.KernelSessionForeign as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e))


@router.get("/sessions", response_model=list[ExecutionSessionResponse])
async def list_sessions(
    project_uid: str = Query(alias="projectUid"),
    language: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The caller's named execution sessions for a project (per-user, never shared).

    Filtered to one language when ``language`` is given — a session is language-scoped.
    """
    await _require_project_access(db, project_uid, user, "ide:read")
    return await execution_session_service.list_for_user(
        db, project_uid, user.id, language
    )


@router.post("/sessions", response_model=ExecutionSessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session(
    body: ExecutionSessionCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_code_execution(db, body.project_uid, user)
    return await execution_session_service.create(db, body, user.id)


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Drop a session and kill its live kernels. Only the owner may delete it."""
    session = await execution_session_service.get(db, session_id)
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if session.user_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your session")
    try:
        await kernel.manager.shutdown_session(
            session.project_uid, user.id, session.id, via=audit.actor().get("via"),
        )
    except kernel.KernelSessionForeign as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e))
    await execution_session_service.delete(db, session)


async def _make_ws_resolver(connection_id: str | None, user: User):
    """Build a SQL resolver bound to the connection, if any (mirrors POST /execute
    so sql_query() works in the terminal too). Loaded once at connect time.

    Enforces workspace read access on the source, like the HTTP path — otherwise a
    terminal could bind an arbitrary connectionId from another workspace."""
    if not connection_id:
        return None
    async with async_session() as db:
        try:
            source = await _require_connection_access(db, connection_id, user)
        except HTTPException:
            return None

    async def resolver(sql: str):
        with audit.event_scope():
            async with async_session() as db:
                login = await database_credential_service.resolve_login(db, source, user.id)
                return await data_source_service.query(db, source, login, sql)

    return resolver


async def _terminal_kernel_loop(
    websocket: WebSocket, project_uid: str, language: str, session_id: str,
    connection_id: str | None, user: User,
) -> None:
    """REPL over a persistent R/Python kernel: each {code} message streams
    stdout/stderr chunks back live, then a {done} with figures/table. {interrupt}
    sends SIGINT to the running run.

    A run must not block the receive loop, or the {interrupt} that should stop it
    would sit unread until the run finished. So each {code} runs as its own task
    while the loop keeps reading, letting {interrupt} fire mid-run."""
    async with async_session() as db:
        environment = await environments.resolve(db, project_uid, language)
        # Auto-build before the kernel starts, like the non-streaming /execute route:
        # otherwise this path runs against an unmaterialised library and every
        # `library(...)` fails. The build can take minutes, so stream a notice + its
        # log to the console — the client would otherwise sit on "Loading R runtime".
        if environments.needs_build(environment):
            try:
                await environments.require_spec_accepted(db, user.id, project_uid, language)
            except code_acceptance_service.EnvironmentNotAccepted as e:
                await websocket.send_json({"type": "error", **e.detail})
                await websocket.close()
                return
            await websocket.send_json({
                "type": "stdout",
                "data": f"Building {environments.language_label(language)} environment…\n",
            })

            async def build_log(line: str) -> None:
                await websocket.send_json({"type": "stdout", "data": line.rstrip() + "\n"})

            try:
                environment = await environments.ensure_ready(
                    db, project_uid, language, user.id, on_log=build_log
                )
                await websocket.send_json({"type": "stdout", "data": "Environment ready.\n"})
            except Exception as e:  # noqa: BLE001 — surface the build failure, keep the socket
                await websocket.send_json({"type": "stderr", "data": f"Environment build failed: {e}\n"})
    try:
        k = await kernel.manager.get(
            project_uid, user.id, language, session_id, environment,
            _kernel_token(user, project_uid), via=audit.actor().get("via"),
        )
    except (kernel.KernelLimitReached, kernel.KernelSessionForeign) as e:
        await websocket.send_json({"type": "error", "data": str(e)})
        await websocket.close()
        return
    resolver = await _make_ws_resolver(connection_id, user)

    # Set on socket teardown so the drain below reads the run to completion WITHOUT
    # sending: the socket is already closed, and a failing send would abort the drain
    # after one chunk, leaving the rest of the run's output in the pipe.
    draining = False

    async def on_chunk(kind: str, data: str) -> None:
        if draining:
            return
        await websocket.send_json({"type": kind, "data": data})

    async def run(code: str) -> None:
        try:
            out = await k.execute_stream(code, on_chunk, query_resolver=resolver)
            if draining:
                return
            await websocket.send_json({
                "type": "done",
                "figures": [
                    {"id": f"fig-{i}", "type": f["type"], "data": f["data"], "label": f["label"]}
                    for i, f in enumerate(out.figures)
                ],
                "table": out.table,
                "html": out.html,
                "failed": out.failed,
            })
        except runtime.ExecutionError as e:
            if draining:
                return
            await websocket.send_json({"type": "error", "message": str(e)})

    current: asyncio.Task | None = None
    try:
        while True:
            msg = await websocket.receive_json()
            if msg.get("interrupt"):
                k.interrupt()
                continue
            code = msg.get("code")
            if code is None:
                continue
            # One run at a time (REPL); ignore a new line while one is in flight.
            if current is not None and not current.done():
                continue
            audit.event(action="run_code", project_uid=project_uid, detail=code)
            current = asyncio.create_task(run(code))
    finally:
        # The IDE client stops a run by CLOSING this socket (and SIGINT'ing via the
        # HTTP route), which lands here as a receive error. Do NOT just cancel the
        # run task: cancelling mid-stream abandons the kernel's stdout pipe with the
        # run still writing (its remaining prints + done payload), and those bytes
        # are then read at the START of the NEXT run — output bleeds across runs and
        # a stale done makes a fresh run look finished in milliseconds. Instead
        # SIGINT the kernel and let the task DRAIN the pipe to its done payload, so
        # the kernel is left clean and back to idle. Bounded so a wedged kernel
        # can't hang the socket teardown forever.
        if current is not None and not current.done():
            # Stop sending to the (already closed) socket first: the drain below reads
            # the run's remaining chunks, and each one would otherwise try a send on a
            # dead WebSocket, raise, and abort the drain after a single line — leaving
            # the leftovers in the pipe, i.e. exactly what the drain exists to avoid.
            draining = True
            k.interrupt()
            try:
                await asyncio.wait_for(current, timeout=settings.execution_timeout_seconds)
            except asyncio.CancelledError:
                # The server itself is shutting us down — never swallow cancellation.
                current.cancel()
                raise
            except Exception:  # noqa: BLE001 — drain best-effort; teardown must not raise
                if not current.done():
                    current.cancel()


async def _terminal_pty_loop(
    websocket: WebSocket, project_uid: str, session_id: str, user: User
) -> None:
    """Interactive Bash over a PTY: pump raw bytes both ways. Client sends
    {input} keystrokes (Ctrl+C is byte 0x03, handled natively by the PTY) and
    {resize}; the shell's output is forwarded as {output} messages."""
    try:
        shell = await pty_kernel.manager.create(
            project_uid, session_id, user.id, _kernel_token(user, project_uid)
        )
    except (pty_kernel.SessionLimitReached, pty_kernel.TerminalUnsupported) as e:
        await websocket.send_json({"type": "error", "message": str(e)})
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    async def pump_output() -> None:
        while True:
            data = await shell.read()
            if not data:
                await websocket.send_json({"type": "exit"})
                return
            await websocket.send_json({"type": "output", "data": data.decode("utf-8", "replace")})

    pump = asyncio.create_task(pump_output())
    try:
        while True:
            msg = await websocket.receive_json()
            if "input" in msg:
                shell.write(msg["input"].encode("utf-8"))
            elif "resize" in msg:
                shell.resize(int(msg["resize"]["rows"]), int(msg["resize"]["cols"]))
    finally:
        pump.cancel()
        pty_kernel.manager.close(project_uid, session_id)


@router.websocket("/terminal")
async def terminal_ws(websocket: WebSocket):
    """Interactive server terminal (storage plan §07d). Python/R attach to the
    project's persistent kernel (shared variables with IDE runs); Bash gets a
    dedicated PTY shell. Auth via ?token= (no Authorization header on WS)."""
    user = await authenticate_ws(websocket)
    if user is None:
        return  # authenticate_ws already closed with WS_AUTH_FAILED

    project_uid = websocket.query_params.get("projectUid")
    language = websocket.query_params.get("language", "python")
    if not project_uid or language not in ("python", "r", "bash"):
        await refuse(websocket, status.WS_1008_POLICY_VIOLATION)
        return
    audit.bind(project_uid=project_uid)
    if not settings.enable_code_execution:
        await refuse(websocket, WS_FORBIDDEN)
        return

    # A terminal opens an arbitrary shell/kernel in the project's working dir, so
    # it requires the same ide:execute permission as running code over HTTP, for as
    # long as it stays open. The HTTP dependency system doesn't apply to a raw
    # WebSocket, so check here.
    async def may_execute(current: User) -> bool:
        try:
            async with async_session() as db:
                await _require_code_execution(db, project_uid, current)
            return True
        except HTTPException:
            return False

    if not await may_execute(user):
        await refuse(websocket, WS_FORBIDDEN)
        return

    await websocket.accept()
    session_id = uuid.uuid4().hex if language == "bash" else websocket.query_params.get("sessionId", "default")
    detail = f"{language} session {session_id}"
    audit.event(action="terminal_open", project_uid=project_uid, detail=detail)
    audit.bind(action="terminal_close", detail=detail)
    if language == "bash":
        # Keystrokes stay out of the log: a shell also receives what it does not echo.
        loop = _terminal_pty_loop(websocket, project_uid, session_id=session_id, user=user)
    else:
        loop = _terminal_kernel_loop(
            websocket, project_uid, language, session_id,
            websocket.query_params.get("connectionId"), user,
        )
    session = asyncio.create_task(loop)
    watch = asyncio.create_task(watch_credentials(websocket, TERMINAL_AUTH_RECHECK_SECONDS, may_execute))
    try:
        await asyncio.wait({session, watch}, return_when=asyncio.FIRST_COMPLETED)
        if not session.done():
            session.cancel()
            await asyncio.gather(session, return_exceptions=True)
            await websocket.close(code=watch.result())
            return
        session.result()
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 — a broken terminal must not crash the worker
        logger.exception("terminal_ws_error", project=project_uid, language=language)
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except RuntimeError:
            pass
    finally:
        watch.cancel()
        if not session.done():
            session.cancel()
