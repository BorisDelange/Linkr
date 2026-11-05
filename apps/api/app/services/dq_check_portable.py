"""A data-quality check as `checks.json` writes it.

Twin of apps/web/src/lib/dq-check-portable.ts (`portableChecks`): no local id,
rule-set id or last-edit date — those churned every pull and push — and the
checks in display order, ties broken by id. Both builders must write the same
bytes.
"""

_LOCAL_FIELDS = ("id", "ruleSetId", "updatedAt")


def portable_checks(checks: list[dict]) -> list[dict]:
    ordered = sorted(checks, key=lambda c: (c.get("order") or 0, str(c.get("id") or "")))
    return [{k: v for k, v in c.items() if k not in _LOCAL_FIELDS} for c in ordered]
