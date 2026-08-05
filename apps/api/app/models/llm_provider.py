from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin, UUIDPKMixin


class LlmProvider(Base, UUIDPKMixin, TimestampMixin):
    """A workspace's LLM endpoint, used by the IDE CLI agents and the dashboard
    copilot. The API key is encrypted at rest (Fernet, see core/crypto.py) and
    never returned by the API — same contract as external DB passwords.

    Health-data safety is the whole point of this table: a remote provider means
    prompts (which may carry clinical context) leave the institution. Hence
    `is_local` is derived server-side from `base_url` rather than declared by the
    client, and creating a non-local provider requires an explicit, recorded
    acknowledgement (see the `acknowledged_*` columns) on top of the
    LINKR_ALLOW_REMOTE_LLM instance switch.
    """

    __tablename__ = "llm_providers"

    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    # "local-openai-compatible" (Ollama/LM Studio/llama.cpp/vLLM), "anthropic",
    # "openai", "mistral", "gemini", "custom". Drives which adapter the agent
    # loop uses; the OpenAI-compatible shape is the default path.
    kind: Mapped[str] = mapped_column(String(40), default="local-openai-compatible")
    base_url: Mapped[str] = mapped_column(String(500), default="")
    model: Mapped[str] = mapped_column(String(200), default="")
    api_key_encrypted: Mapped[str | None] = mapped_column(Text)
    # Derived from base_url at write time, never trusted from the client: a user
    # must not be able to flag api.openai.com as "local". Stored (not computed on
    # read) so the value that was true at acknowledgement time stays auditable.
    is_local: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1")

    # Decision trail for sending health data to an external API. Only set for
    # non-local providers; kept for audit, so it is deliberately not cleared when
    # the provider is later edited back to a local URL.
    acknowledged_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    acknowledged_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    acknowledgement_text: Mapped[str | None] = mapped_column(Text)

    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
