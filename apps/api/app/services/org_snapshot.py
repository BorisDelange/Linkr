from sqlalchemy.ext.asyncio import AsyncSession

from app.core.datetime_format import normalize_iso_ms_z


async def resolve_entity_org_snapshot(db: AsyncSession, entity) -> dict | None:
    """Resolve the inline organization snapshot for a standalone single-entity
    export — the backend port of ``resolveEntityOrganization`` + ``orgSnapshot``
    (entity-io.ts). Prefers the entity's own frozen ``organization`` snapshot, else
    the parent workspace's org (``workspace_id`` → ``workspace.organization_id`` →
    org). Returns a snapshot dict ready to inline as the last key, or None when the
    entity has no workspace / the workspace no org. Import re-links by the org's
    stable UUID."""
    from app.schemas.organization import OrganizationResponse
    from app.services import organization_service, workspace_service

    own = getattr(entity, "organization", None)
    if own:
        return org_snapshot(own if isinstance(own, dict) else dict(own))

    workspace_id = getattr(entity, "workspace_id", None)
    if not workspace_id:
        return None
    workspace = await workspace_service.get(db, workspace_id)
    if not workspace or not workspace.organization_id:
        return None
    org = await organization_service.get(db, workspace.organization_id)
    if not org:
        return None
    org_dict = OrganizationResponse.model_validate(org).model_dump(by_alias=True, mode="json")
    return org_snapshot(org_dict)


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
