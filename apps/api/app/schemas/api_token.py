from datetime import datetime

from pydantic import Field, field_validator

from app.schemas.base import CamelModel


class ApiTokenCreate(CamelModel):
    name: str = Field(min_length=1, max_length=255)
    # None = never expires.
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name must not be blank")
        return value


class ApiTokenResponse(CamelModel):
    id: str
    name: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None = None
    expires_at: datetime | None = None
    revoked_at: datetime | None = None


class ApiTokenCreated(ApiTokenResponse):
    """Returned once, on creation: the only time the plaintext token is sent."""

    token: str
