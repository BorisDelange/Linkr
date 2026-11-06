"""Which code a user has accepted to have run on its own.

The app starts stored code by itself when a page opens: dashboard widgets, dataset
analyses, patient-board plugins. That code may come from an import, a clone, a
pull, a colleague or an API key, and it runs with the viewer's access. So a run for
any purpose other than the IDE needs the running user's acceptance of exactly that
text. The rule keys on the text rather than on who stored it: an edit, a reimport
and a pull are all a new text, whichever route they took.

Accepting takes a web session (see the route): an API key or a kernel token acts
without the person having seen anything.
"""

import hashlib

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.code_acceptance import CodeAcceptance
from app.models.user import User


def digest(code: str) -> str:
    # surrogatepass: a JSON body can carry a lone surrogate, which is still a text to refuse.
    return hashlib.sha256(code.encode("utf-8", "surrogatepass")).hexdigest()


async def is_accepted(db: AsyncSession, user: User, code: str) -> bool:
    return await db.get(CodeAcceptance, (user.id, digest(code))) is not None


async def accepted_among(db: AsyncSession, user: User, codes: set[str]) -> set[str]:
    by_digest = {digest(code): code for code in codes}
    known = await db.scalars(
        select(CodeAcceptance.digest).where(CodeAcceptance.user_id == user.id, CodeAcceptance.digest.in_(by_digest))
    )
    return {by_digest[d] for d in known}


async def accept(db: AsyncSession, user: User, codes: list[str]) -> None:
    digests = {digest(code) for code in codes}
    known = set((await db.scalars(
        select(CodeAcceptance.digest).where(CodeAcceptance.user_id == user.id, CodeAcceptance.digest.in_(digests))
    )).all())
    db.add_all(CodeAcceptance(user_id=user.id, digest=d) for d in digests - known)
    await db.commit()


async def require_accepted(db: AsyncSession, user: User, purpose: str, code: str) -> None:
    """Only the IDE's own runs pass unchecked: the person pressed Run on what they see."""
    if purpose == "ide" or await is_accepted(db, user, code):
        return
    raise HTTPException(
        status.HTTP_428_PRECONDITION_REQUIRED,
        {"code": "code_acceptance_required", "message": "This code must be accepted before it runs"},
    )
