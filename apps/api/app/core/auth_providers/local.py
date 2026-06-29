from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth_providers.base import AuthProvider
from app.core.security import verify_password
from app.models.user import User


class LocalAuthProvider(AuthProvider):
    """Authenticate against the locally stored bcrypt password hash."""

    async def authenticate(
        self, username: str, password: str, db: AsyncSession
    ) -> User | None:
        result = await db.execute(select(User).where(User.username == username))
        user = result.scalar_one_or_none()
        if user is None or user.password_hash is None:
            return None
        if not verify_password(password, user.password_hash):
            return None
        return user
