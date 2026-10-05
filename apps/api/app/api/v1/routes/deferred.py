"""Poll a request that outlived the gateway timeout (see ``core.deferred``)."""

from fastapi import APIRouter, Depends, HTTPException, status

from app.core import deferred
from app.core.deps import get_current_user
from app.models.user import User

router = APIRouter(prefix="/deferred", tags=["deferred"])


@router.get("/{task_id}")
async def poll_deferred(task_id: str, user: User = Depends(get_current_user)):
    """202 while the work runs, then the response the original route would have
    sent — its body, or its error status. Only the user who started it may read it."""
    outcome = deferred.poll(user.id, task_id)
    if outcome is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown or expired task")
    return outcome
