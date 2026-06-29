from pydantic import BaseModel, ConfigDict
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
