from sqlalchemy import Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin, UUIDPKMixin


class Role(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "roles"

    # Machine key referenced by users/members (e.g. "editor", "data-scientist").
    name: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    label: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    # "workspace" roles gate workspace-scoped entities; "global" roles gate the account.
    scope: Mapped[str] = mapped_column(String(20), default="workspace")
    # System roles ship by default and cannot be deleted; their permissions stay editable.
    is_system: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    # Flat list of "resource:action" strings drawn from the code-defined catalogue.
    permissions: Mapped[list] = mapped_column(JSONB_or_JSON, default=list)
