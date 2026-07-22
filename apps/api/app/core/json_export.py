"""Shared JSON serialization for the export builders (project, workspace,
mapping-project, and the standalone entity scopes). The single source of truth for
byte-parity with the frontend's ``JSON.stringify(x, null, 2)`` — every server-side
export builder MUST route through ``export_json`` so a WASM client and a server
client versioning the same entity to one git remote produce identical bytes."""

import json
from typing import Any


def js_numbers(value: Any) -> Any:
    """Normalize whole-valued floats to int so serialization matches JS.
    ``JSON.stringify(1.0)`` → ``"1"`` but Python ``json.dumps(1.0)`` → ``"1.0"``;
    a whole-valued float (a DQ ``threshold`` of 0/100, a ``matchScore`` of 1.0)
    would otherwise emit different bytes server- vs client-side → a spurious git
    diff on a shared remote. Fractions (0.85) are left untouched (JS keeps them)."""
    if isinstance(value, bool):
        return value  # bool is an int subclass — never coerce
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: js_numbers(v) for k, v in value.items()}
    if isinstance(value, list):
        return [js_numbers(v) for v in value]
    return value


def export_json(value: Any) -> bytes:
    """Serialize like TS ``JSON.stringify(x, null, 2)``: 2-space indent, ``": "``
    and ``",\\n"`` separators, insertion-order keys (never sorted), UTF-8, no
    trailing newline, JS number formatting (whole floats as ints)."""
    return json.dumps(
        js_numbers(value), indent=2, ensure_ascii=False, separators=(",", ": ")
    ).encode("utf-8")
