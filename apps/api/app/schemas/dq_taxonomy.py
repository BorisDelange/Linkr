"""Data-quality taxonomy (Kahn et al. 2016), the server twin of
`apps/web/src/lib/dq-taxonomy.ts` — keep the two in step."""

DQ_CATEGORIES = ("conformance", "completeness", "plausibility")
DQ_SEVERITIES = ("error", "warning", "notice")
DQ_SUBCATEGORIES: dict[str, tuple[str, ...]] = {
    "conformance": ("value", "relational", "computational"),
    "completeness": (),
    "plausibility": ("uniqueness", "atemporal", "temporal"),
}

# The five categories used before the Kahn taxonomy, which older exports carry.
LEGACY_CATEGORIES: dict[str, tuple[str, str]] = {
    "validity": ("conformance", "value"),
    "consistency": ("conformance", "relational"),
    "uniqueness": ("plausibility", "uniqueness"),
}


def normalize_category(category: str, subcategory: str | None) -> tuple[str, str | None]:
    """The Kahn category and subcategory for a stored or imported pair; raises
    ValueError for a value outside the taxonomy."""
    if category in LEGACY_CATEGORIES:
        return LEGACY_CATEGORIES[category]
    if category not in DQ_CATEGORIES:
        raise ValueError(f"category must be one of {', '.join(DQ_CATEGORIES)}")
    if subcategory is not None and subcategory not in DQ_SUBCATEGORIES[category]:
        allowed = ", ".join(DQ_SUBCATEGORIES[category]) or "none"
        raise ValueError(f"subcategory of {category} must be one of: {allowed}")
    return category, subcategory


def fitting_subcategory(category: str, subcategory: str | None) -> str | None:
    """The editor's rule when a check changes category: its subcategory if it
    still fits, else the category's first."""
    options = DQ_SUBCATEGORIES[category]
    if subcategory in options:
        return subcategory
    return options[0] if options else None


def normalize_severity(severity: str) -> str:
    """`info` is what older exports call `notice`."""
    if severity == "info":
        return "notice"
    if severity not in DQ_SEVERITIES:
        raise ValueError(f"severity must be one of {', '.join(DQ_SEVERITIES)}")
    return severity


def check_threshold(threshold: float) -> float:
    if not 0 <= threshold <= 100:
        raise ValueError("threshold is a percentage of violated rows, between 0 and 100")
    return threshold
