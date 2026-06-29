from abc import ABC, abstractmethod

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User


class AuthProvider(ABC):
    """Strategy for authenticating a username/password pair.

    Implementations return the authenticated User (provisioning it just-in-time
    for external directories) or None when credentials are invalid.
    """

    @abstractmethod
    async def authenticate(
        self, username: str, password: str, db: AsyncSession
    ) -> User | None: ...
