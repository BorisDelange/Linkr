"""Server-side port of the frontend's mapping-status logic
(`apps/web/src/lib/concept-mapping/mapping-status.ts`). Kept byte-for-byte
equivalent so server-computed stats / mapped-keys never diverge from what the
client would compute in standalone mode. Change both together."""

from app.models.mapping_project import ConceptMapping

# Decisive statuses only. 'unchecked' and 'suggested' are pending states
# ("no opinion" / "awaiting validation"), not decisions.
_DECISIVE = ("approved", "rejected", "flagged", "ignored", "invalid")


def effective_mapping_status(mapping: ConceptMapping) -> str | None:
    """Effective status of a mapping given its review votes.
    - No reviews → the stored status.
    - Reviewers disagree (≥2 distinct decisive statuses) → 'disputed'.
    - Otherwise → the unique decisive status used by reviewers."""
    reviews = mapping.reviews or []
    if not reviews:
        return mapping.status
    present = {
        s for s in _DECISIVE
        if any(r.get("status") == s for r in reviews)
    }
    if not present:
        return mapping.status
    if len(present) > 1:
        return "disputed"
    return next(iter(present))


def source_key(mapping: ConceptMapping) -> str:
    """Stable dedup key for a source concept (vocabulary + code) — matches
    `sourceKey()` on the client (NUL separator, empty string for null)."""
    vocab = mapping.source_vocabulary_id or ""
    code = mapping.source_concept_code or ""
    return f"{vocab}\0{code}"
