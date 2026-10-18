from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.schema_preset import SchemaPreset
from app.models.user import User
from app.schemas.schema_preset import SchemaPresetResponse, SchemaPresetSave
from app.services import notification_service, schema_preset_service

router = APIRouter(prefix="/schema-presets", tags=["schema-presets"])


# --- Notifications (writes by an external client, e.g. an agent over MCP) ---

# What a save can change that the user would want told about. The rest is
# identity, provenance or the git link (whose stored token is sealed, so it never
# compares equal to what a client sends back).
_CONTENT_FIELDS = ("mapping", "readme", "license", "badges", "version", "organization")
_SINGLETON_RELATIONS = ("patient", "visit", "visitDetail", "note")
_LIST_RELATIONS = (("concepts", "key"), ("events", "label"), ("drugs", "label"))


def _relations(mapping: dict | None) -> dict[str, dict]:
    """A mapping's relations by the key the MCP and the editor name them with:
    patient, visit, …, concepts.<key>, events.<label>, drugs.<label>."""
    mapping = mapping or {}
    out = {k: mapping[k] for k in _SINGLETON_RELATIONS if mapping.get(k)}
    for list_key, name_key in _LIST_RELATIONS:
        for spec in mapping.get(list_key) or []:
            if isinstance(spec, dict) and spec.get(name_key):
                out[f"{list_key}.{spec[name_key]}"] = spec
    return out


def _relation_detail(before: dict | None, after: dict | None) -> dict:
    """Which relation a save touched, when it touched any: the first one by name,
    with a count when there are several."""
    old, new = _relations(before), _relations(after)
    touched = sorted(k for k in old.keys() | new.keys() if old.get(k) != new.get(k))
    if not touched:
        return {}
    first = touched[0]
    action = "created" if first not in old else "deleted" if first not in new else "updated"
    return {"part": "relation", "action": action, "name": first, "count": len(touched)}


async def _notify(
    db: AsyncSession, request: Request, user: User, action: str, preset: SchemaPreset, detail: dict | None = None,
) -> None:
    """One change to a schema preset. A workspace preset carries its workspace in
    `detail` (the bell links there); a built-in one has none."""
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="schema_preset", entity_id=preset.id, project_uid=None,
        label=(preset.mapping or {}).get("presetLabel") or preset.entity_id,
        detail={**({"workspaceId": preset.workspace_id} if preset.workspace_id else {}), **(detail or {})},
    )


@router.get("", response_model=list[SchemaPresetResponse])
async def list_schema_presets(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await schema_preset_service.list_for_user(db, user)


@router.put("/{key}", response_model=SchemaPresetResponse)
async def save_schema_preset(
    key: str,
    body: SchemaPresetSave,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # The URL names the entity by `id` like every other route. `preset_id` is
    # still accepted (service.get resolves either) so a client or a bookmark
    # predating the split keeps working.
    if key not in (body.id, body.preset_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="id in body must match the URL",
        )
    # save() upserts and can re-parent an existing preset. Authorize
    # BOTH the current workspace (so a stranger can't overwrite/steal an existing
    # preset via a known id) and the target workspace (so it can't be planted
    # somewhere the caller lacks rights), mirroring the delete handler.
    existing = await schema_preset_service.get(db, key)
    if existing is not None and existing.workspace_id is not None:
        await check_workspace_permission(db, existing.workspace_id, user, "schemas:write")
    if body.workspace_id is not None:
        await check_workspace_permission(db, body.workspace_id, user, "schemas:write")
    sent = body.model_dump()
    before = (
        {k: getattr(existing, k) for k in _CONTENT_FIELDS if getattr(existing, k) != sent[k]}
        if existing is not None else None
    )
    preset = await schema_preset_service.save(db, body)
    if before is None:
        await _notify(db, request, user, "created", preset)
    elif before:
        detail = _relation_detail(before["mapping"], preset.mapping) if "mapping" in before else None
        await _notify(db, request, user, "updated", preset, detail)
    return preset


@router.delete("/{key}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schema_preset(
    key: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    preset = await schema_preset_service.get(db, key)
    if preset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if preset.workspace_id is not None:
        await check_workspace_permission(db, preset.workspace_id, user, "schemas:delete")
    await schema_preset_service.delete(db, preset)
    await _notify(db, request, user, "deleted", preset)
