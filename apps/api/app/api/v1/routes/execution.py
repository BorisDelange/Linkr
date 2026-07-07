from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import get_current_user
from app.models.user import User
from app.schemas.execution import (
    ExecuteRequest,
    ExecuteResponse,
    RuntimeFigureResponse,
)
from app.services.execution import runtime

router = APIRouter(prefix="/execute", tags=["execution"])


@router.post("", response_model=ExecuteResponse)
async def execute_code(
    body: ExecuteRequest,
    user: User = Depends(get_current_user),
):
    """Run R/Python server-side and return the captured output.

    Only the rendered result crosses the wire (stdout/stderr/figures/table) —
    never the underlying data (see storage plan §03/§06)."""
    try:
        if body.language == "python":
            out = await runtime.run_python(body.code)
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
