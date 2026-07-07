from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.user import User
from app.schemas.execution import (
    ExecuteRequest,
    ExecuteResponse,
    RestartKernelRequest,
    RuntimeFigureResponse,
)
from app.services import dataset_service
from app.services.execution import injection, kernel, runtime

router = APIRouter(prefix="/execute", tags=["execution"])


async def _dataset_preamble(db: AsyncSession, dataset_file_id: str, language: str) -> str:
    """Server-side `dataset` injection code for the requested dataset."""
    node = await dataset_service.get(db, dataset_file_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
    return (
        injection.python_preamble(node)
        if language == "python"
        else injection.r_preamble(node)
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
    code = body.code
    if body.dataset_file_id and body.language in ("python", "r"):
        preamble = await _dataset_preamble(db, body.dataset_file_id, body.language)
        code = preamble + "\n" + code
    try:
        # With a project context, reuse a persistent kernel so variables survive
        # between runs (§07). Context-less runs stay stateless one-shots.
        if body.language in ("python", "r") and body.project_uid:
            k = await kernel.manager.get(body.project_uid, body.language, body.env_id)
            out = await k.execute(code)
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
):
    """Live kernels for a project (language, env, alive, busy) — feeds the IDE footer."""
    return kernel.manager.list_for_project(project_uid)


@router.post("/restart", status_code=status.HTTP_204_NO_CONTENT)
async def restart_kernel(
    body: RestartKernelRequest,
    user: User = Depends(get_current_user),
):
    """Kill the persistent kernel for (project, language, env) so the next run
    starts with a clean namespace."""
    await kernel.manager.restart(body.project_uid, body.language, body.env_id)
