from datetime import datetime, timezone


def to_iso_ms_z(value: datetime) -> str:
    """Format a datetime exactly like the frontend's Date.toISOString(): UTC,
    millisecond precision, trailing 'Z'. This is the single source of truth for
    the export/API datetime format, shared by CamelModel's serializer (first-class
    datetime fields) and the inline-organization snapshot (a JSON blob whose inner
    createdAt escapes Pydantic). Naive values are treated as UTC."""
    utc = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def normalize_iso_ms_z(value: str | None) -> str | None:
    """Coerce an ISO string (any precision/offset, or a plain date) to the ms+Z
    form. Used to normalize timestamps embedded in JSON blobs. Returns the input
    unchanged when it can't be parsed (never raises)."""
    if not value:
        return value
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    return to_iso_ms_z(dt)
