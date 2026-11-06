from fastapi import APIRouter, Depends, status
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit
from app.core.database import get_db
from app.core.deps import get_session_user
from app.models.user import User
from app.schemas.base import CamelModel
from app.services import code_acceptance_service

router = APIRouter(prefix="/code-acceptances", tags=["execution"])


class AcceptCode(CamelModel):
    codes: list[str] = Field(min_length=1, max_length=100)


class CheckCode(CamelModel):
    code: str


class CheckResult(CamelModel):
    accepted: bool


# get_session_user, on both routes: an API key or a kernel token must not be able to
# accept code on behalf of the person it authenticates as.
@router.post("", status_code=status.HTTP_204_NO_CONTENT)
async def accept_code(
    body: AcceptCode,
    user: User = Depends(get_session_user),
    db: AsyncSession = Depends(get_db),
):
    audit.bind(action="accept_code", detail="\n\n".join(body.codes))
    await code_acceptance_service.accept(db, user, body.codes)


@router.post("/check", response_model=CheckResult)
async def check_code(
    body: CheckCode,
    user: User = Depends(get_session_user),
    db: AsyncSession = Depends(get_db),
):
    return CheckResult(accepted=await code_acceptance_service.is_accepted(db, user, body.code))
