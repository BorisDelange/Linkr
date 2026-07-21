from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, ConfigDict, field_serializer
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Base schema for all entity API models.

    Emits camelCase (createdAt, gitRemoteConfig, …) to match the frontend
    TypeScript types, while still accepting snake_case on input. Read directly
    from ORM objects via from_attributes.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
    )

    @field_serializer("*", mode="wrap")
    def _serialize_datetimes(self, value: Any, handler: Any) -> Any:
        """Emit every datetime exactly like the frontend's Date.toISOString():
        UTC, millisecond precision, trailing 'Z'. Pydantic's default isoformat()
        yields microseconds and a '+00:00' offset (or none for naive values), so
        the same record exported by the API vs. the browser produced different
        strings and churned the git diff. Non-datetime fields pass through."""
        if isinstance(value, datetime):
            utc = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
            return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"
        return handler(value)
