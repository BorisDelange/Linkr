import asyncio

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, status
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocketDisconnect

from app.config import settings
from app.core.database import async_session, get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_role
from app.core.ws_auth import authenticate_ws
from app.models.project import Project
from app.models.user import User
from app.schemas.execution import (
    ExecuteRequest,
    ExecuteResponse,
    RestartKernelRequest,
    RuntimeFigureResponse,
)
from app.services import data_source_service, dataset_service
from app.services.data import dataset_fs
from app.services.execution import injection, kernel, pty_kernel, runtime

logger = structlog.get_logger()

router = APIRouter(prefix="/execute", tags=["execution"])


async def _require_project_access(
    db: AsyncSession, project_uid: str, user: User, min_role: str
) -> None:
    """Running code in a project (or attaching a terminal to it) requires the same
    workspace membership as reading its files — mirrors dataset_files/ide_files."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if project.workspace_id is not None:
        await check_workspace_role(db, project.workspace_id, user, min_role)


async def _require_connection_access(
    db: AsyncSession, connection_id: str, user: User
):
    """Load a data source only if the user may read its workspace. Returns the
    source (guarding sql_query() from reaching an arbitrary connection)."""
    source = await data_source_service.get(db, connection_id)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
    if source.workspace_id is not None:
        await check_workspace_role(db, source.workspace_id, user, "viewer")
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
            res = dataset_fs.resolve_cache(project_uid, dataset_ref)
        except FileNotFoundError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
        path = res["parquet"].as_posix()
        columns = res["columns"]
        return (
            injection.python_preamble_from(path, columns, filters)
            if language == "python"
            else injection.r_preamble_from(path, columns, filters)
        )
    node = await dataset_service.get(db, dataset_ref)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
    return (
        injection.python_preamble(node, filters)
        if language == "python"
        else injection.r_preamble(node, filters)
    )


@router.post("", response_model=ExecuteResponse)
async def execute_code(
    body: ExecuteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run R/Python server-side and return the captured output.

    Only the rendered result crosses the wire (stdout/stderr/figures/table) —
    never the underlying data (see storage plan §03/§06)."""
    if body.project_uid:
        await _require_project_access(db, body.project_uid, user, "editor")

    code = body.code
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

        async def resolver(sql: str):
            return await data_source_service.query(source, sql)

    try:
        # With a project context, reuse a persistent kernel so variables survive
        # between runs (§07). Context-less runs stay stateless one-shots.
        if body.language in ("python", "r") and body.project_uid:
            k = await kernel.manager.get(body.project_uid, body.language, body.env_id)
            out = await k.execute(code, query_resolver=resolver)
        elif body.language == "python":
            out = await runtime.run_python(code)
        elif body.language == "r":
            out = await runtime.run_r(code)
        else:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Unsupported language: {body.language}",
            )
    except runtime.ExecutionError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))

    return ExecuteResponse(
        stdout=out.stdout,
        stderr=out.stderr,
        figures=[
            RuntimeFigureResponse(id=f"fig-{i}", type=f["type"], data=f["data"], label=f["label"])
            for i, f in enumerate(out.figures)
        ],
        table=out.table,
        html=out.html,
    )


@router.get("/kernels")
async def list_kernels(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Live kernels for a project (language, env, alive, busy) — feeds the IDE footer."""
    await _require_project_access(db, project_uid, user, "viewer")
    return kernel.manager.list_for_project(project_uid)


@router.post("/restart", status_code=status.HTTP_204_NO_CONTENT)
async def restart_kernel(
    body: RestartKernelRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Kill the persistent kernel for (project, language, env) so the next run
    starts with a clean namespace."""
    await _require_project_access(db, body.project_uid, user, "editor")
    await kernel.manager.restart(body.project_uid, body.language, body.env_id)


async def _make_ws_resolver(connection_id: str | None):
    """Build a SQL resolver bound to the connection, if any (mirrors POST /execute
    so sql_query() works in the terminal too). Loaded once at connect time."""
    if not connection_id:
        return None
    async with async_session() as db:
        source = await data_source_service.get(db, connection_id)
    if source is None:
        return None

    async def resolver(sql: str):
        return await data_source_service.query(source, sql)

    return resolver


async def _terminal_kernel_loop(
    websocket: WebSocket, project_uid: str, language: str, env_id: str, connection_id: str | None
) -> None:
    """REPL over a persistent R/Python kernel: each {code} message streams
    stdout/stderr chunks back live, then a {done} with figures/table. {interrupt}
    sends SIGINT to the running run.

    A run must not block the receive loop, or the {interrupt} that should stop it
    would sit unread until the run finished. So each {code} runs as its own task
    while the loop keeps reading, letting {interrupt} fire mid-run."""
    k = await kernel.manager.get(project_uid, language, env_id)
    resolver = await _make_ws_resolver(connection_id)

    async def on_chunk(kind: str, data: str) -> None:
        await websocket.send_json({"type": kind, "data": data})

    async def run(code: str) -> None:
        try:
            out = await k.execute_stream(code, on_chunk, query_resolver=resolver)
            await websocket.send_json({
                "type": "done",
                "figures": [
                    {"id": f"fig-{i}", "type": f["type"], "data": f["data"], "label": f["label"]}
                    for i, f in enumerate(out.figures)
                ],
                "table": out.table,
                "html": out.html,
            })
        except runtime.ExecutionError as e:
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
            current = asyncio.create_task(run(code))
    finally:
        if current is not None and not current.done():
            current.cancel()


async def _terminal_pty_loop(
    websocket: WebSocket, project_uid: str, session_id: str, user_id: int
) -> None:
    """Interactive Bash over a PTY: pump raw bytes both ways. Client sends
    {input} keystrokes (Ctrl+C is byte 0x03, handled natively by the PTY) and
    {resize}; the shell's output is forwarded as {output} messages."""
    try:
        shell = await pty_kernel.manager.create(project_uid, session_id, user_id)
    except pty_kernel.SessionLimitReached as e:
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
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    if not settings.enable_code_execution:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # A terminal opens an arbitrary shell/kernel in the project's working dir, so
    # it requires the same editor membership as running code over HTTP. The HTTP
    # dependency system doesn't apply to a raw WebSocket, so check explicitly.
    try:
        async with async_session() as db:
            await _require_project_access(db, project_uid, user, "editor")
    except HTTPException:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    try:
        if language == "bash":
            await _terminal_pty_loop(
                websocket, project_uid, session_id=str(id(websocket)), user_id=user.id
            )
        else:
            env_id = websocket.query_params.get("envId", "default")
            connection_id = websocket.query_params.get("connectionId")
            await _terminal_kernel_loop(websocket, project_uid, language, env_id, connection_id)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 — a broken terminal must not crash the worker
        logger.exception("terminal_ws_error", project=project_uid, language=language)
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except RuntimeError:
            pass
