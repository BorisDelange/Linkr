from datetime import datetime

from app.schemas.base import CamelModel


class LlmProviderCreate(CamelModel):
    workspace_id: str
    name: dict = {}
    kind: str = "local-openai-compatible"
    base_url: str = ""
    model: str = ""
    # Plaintext on the way in only; stored Fernet-encrypted and never returned.
    api_key: str | None = None
    enabled: bool = True
    surfaces: list[str] = []
    # Required by the server when the endpoint is remote (see routes).
    acknowledgement_text: str | None = None


class LlmProviderUpdate(CamelModel):
    name: dict | None = None
    kind: str | None = None
    base_url: str | None = None
    model: str | None = None
    # Absent = leave the stored key untouched; "" = clear it.
    api_key: str | None = None
    enabled: bool | None = None
    surfaces: list[str] | None = None
    acknowledgement_text: str | None = None


class LlmProviderResponse(CamelModel):
    """What the API returns for a provider.

    The API key is deliberately absent: it is decrypted only server-side, when a
    request is actually made to the model. `has_api_key` lets the UI show that
    one is set without ever shipping the secret to a browser.
    """

    id: str
    workspace_id: str
    name: dict
    kind: str
    base_url: str
    model: str
    has_api_key: bool
    is_local: bool
    enabled: bool
    surfaces: list[str]
    acknowledged_by_id: int | None
    acknowledged_at: datetime | None
    created_by_id: int | None
    created_at: datetime
    updated_at: datetime


class BenchCaseResult(CamelModel):
    id: str
    label: str
    lang: str
    ok: bool
    detail: str | None = None
    ms: int
    prompt_tokens: int = 0
    completion_tokens: int = 0
    calls: list[str] = []


class BenchReportCreate(CamelModel):
    """A bench run, stored so an admin's evaluation is visible to everyone.

    Speed figures are machine-specific, so the report records where it ran.
    """

    workspace_id: str
    model: str
    mode: str
    lang: str
    surfaces: list[str] = []
    passed: int
    total: int
    total_ms: int
    prompt_tokens: int = 0
    completion_tokens: int = 0
    tokens_per_second: float = 0
    cases: list[BenchCaseResult] = []


class BenchReportResponse(BenchReportCreate):
    id: str
    ran_by_id: int | None
    ran_at: datetime
