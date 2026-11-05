from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth_providers.base import AuthProvider
from app.core.security import verify_password_async
from app.models.user import User


class LocalAuthProvider(AuthProvider):
    """Authenticate against the locally stored bcrypt password hash."""

    async def authenticate(
        self, username: str, password: str, db: AsyncSession
    ) -> User | None:
        result = await db.execute(select(User).where(User.username == username))
        user = result.scalar_one_or_none()
        if not await verify_password_async(password, user.password_hash if user else None):
            return None
        return user
