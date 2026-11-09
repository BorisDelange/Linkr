"""A data-quality check as `checks.json` writes it, and its portable key.

Twin of apps/web/src/lib/dq-check-portable.ts (`portableChecks`, `checkKeys`):
no local id, rule-set id or last-edit date — those churned every pull and push —
and the checks in display order, ties broken by id, `checkKey` first. Both
builders must write the same bytes.

`checkKey` is set once at creation (the template key of a generated check, else
the slug of its name, `#<n>` on a collision) and never changed: a renamed check
keeps it, so the quality profiles pointing at it still find it.
"""

from collections.abc import Iterable

_LOCAL_FIELDS = ("id", "ruleSetId", "updatedAt", "checkKey")


def check_keys(
    checks: Iterable[tuple[str | None, str | None, str | None]],
    taken: Iterable[str] = (),
) -> list[str]:
    """Each check's key, from (check_key, template_key, name), in the order given:
    the key it carries, else its template key, else the slug of its name —
    `#<n>` when another check, or one of `taken`, has it."""
    # Here, not at the top: workspace_export imports this module.
    from app.services.workspace_export import _slugify

    seen = set(taken)
    keys: list[str] = []
    for check_key, template_key, name in checks:
        base = check_key or template_key or _slugify(name or "check")
        key = base
        n = 2
        while key in seen:
            key = f"{base}#{n}"
            n += 1
        seen.add(key)
        keys.append(key)
    return keys


def portable_checks(checks: list[dict]) -> list[dict]:
    ordered = sorted(checks, key=lambda c: (c.get("order") or 0, str(c.get("id") or "")))
    keys = check_keys((c.get("checkKey"), c.get("templateKey"), c.get("name")) for c in ordered)
    return [
        {"checkKey": key, **{k: v for k, v in c.items() if k not in _LOCAL_FIELDS}}
        for key, c in zip(keys, ordered)
    ]
