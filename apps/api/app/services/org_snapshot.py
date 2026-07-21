from app.core.datetime_format import normalize_iso_ms_z


def org_snapshot(org: dict) -> dict:
    """Reduce an organization to its portable provenance snapshot for an export —
    the single backend counterpart to the frontend's ``orgSnapshot`` (entity-io.ts).

    The organization travels as a JSON blob, so its fields escape both
    ``_strip_instance_fields`` and CamelModel's datetime serializer. This is the one
    place that (a) drops ``updatedAt`` (re-stamped on import; churns the diff) and
    (b) normalizes ``createdAt`` to the ms+Z form the rest of the export uses. Every
    export path that attaches an org (project, mapping-project, workspace root) calls
    this, so the same org serializes identically everywhere."""
    out = {k: v for k, v in org.items() if k != "updatedAt"}
    if isinstance(out.get("createdAt"), str):
        out["createdAt"] = normalize_iso_ms_z(out["createdAt"])
    return out
