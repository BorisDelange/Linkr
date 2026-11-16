"""What a route answers for a refusal raised below it."""

from app.core.redact import redact_secrets


def refusal_detail(error: Exception) -> str | dict:
    """A coded refusal's `{code, message, …}` as it is, so the client words it in
    its language; any other error's text, secrets out."""
    detail = getattr(error, "detail", None)
    if isinstance(detail, dict) and "code" in detail:
        return detail
    return redact_secrets(str(error))
