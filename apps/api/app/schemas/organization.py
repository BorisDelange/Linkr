from datetime import datetime

from app.schemas.base import CamelModel


# Multilingual fields accept a LocalizedString ({"en": ...}) or a legacy string.
LocalizedOrStr = dict[str, str] | str


class OrganizationCreate(CamelModel):
    id: str | None = None  # client supplies crypto.randomUUID()
    name: LocalizedOrStr
    type: str | None = None
    location: LocalizedOrStr | None = None
    country: LocalizedOrStr | None = None
    website: str | None = None
    email: str | None = None
    custom_type: LocalizedOrStr | None = None
    reference_id: str | None = None
    custom_fields: dict[str, str] | None = None


class OrganizationUpdate(CamelModel):
    name: LocalizedOrStr | None = None
    type: str | None = None
    location: LocalizedOrStr | None = None
    country: LocalizedOrStr | None = None
    website: str | None = None
    email: str | None = None
    custom_type: LocalizedOrStr | None = None
    reference_id: str | None = None
    custom_fields: dict[str, str] | None = None
    # Restored on import/clone so the original creation date survives a git
    # round-trip; a normal PATCH never sends it (exclude_unset leaves it alone).
    created_at: datetime | None = None


class OrganizationResponse(CamelModel):
    id: str
    name: LocalizedOrStr
    type: str | None = None
    location: LocalizedOrStr | None = None
    country: LocalizedOrStr | None = None
    website: str | None = None
    email: str | None = None
    custom_type: LocalizedOrStr | None = None
    reference_id: str | None = None
    custom_fields: dict[str, str] | None = None
    created_at: datetime
    updated_at: datetime
