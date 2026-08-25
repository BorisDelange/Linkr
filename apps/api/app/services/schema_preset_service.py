from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.schema_preset import SchemaPreset
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.schemas.schema_preset import SchemaPresetSave
from app.services import attachment_service, git_secret


async def list_for_user(db: AsyncSession, user: User) -> list[SchemaPreset]:
    """Presets in the user's workspaces, plus global (workspace-less) ones."""
    if user.role == "admin":
        result = await db.execute(select(SchemaPreset))
        return list(result.scalars().all())

    member_ws = select(WorkspaceMember.workspace_id).where(
        WorkspaceMember.user_id == user.id
    )
    result = await db.execute(
        select(SchemaPreset).where(
            or_(
                SchemaPreset.workspace_id.is_(None),
                SchemaPreset.workspace_id.in_(member_ws),
            )
        )
    )
    return list(result.scalars().all())


async def list_for_workspace(
    db: AsyncSession, workspace_id: str
) -> list[SchemaPreset]:
    result = await db.execute(
        select(SchemaPreset).where(SchemaPreset.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, key: str) -> SchemaPreset | None:
    """Look a preset up by `id` (the primary key) or by `preset_id`.

    Both resolve because callers still hold either while `preset_id` is retired:
    an existing URL, an export tree, a catalog entry. `id` is tried first — it is
    the key — and the fallback disappears with `preset_id` itself.
    """
    found = await db.get(SchemaPreset, key)
    if found is not None:
        return found
    result = await db.execute(select(SchemaPreset).where(SchemaPreset.preset_id == key))
    return result.scalars().first()


async def reconcile_repo_dirs(db: AsyncSession) -> int:
    """Move on-disk versioning trees still named after a preset's `preset_id`.

    The repo path embeds the entity key, which moved from `preset_id` to `id`
    (revision e6f7a8b9c0d1). A SQL migration cannot rename a directory, so it
    happens here, at startup. Both idempotent and a no-op wherever the two ids
    are equal — which the backfill guarantees for every pre-split row, so this
    typically moves nothing at all.
    """
    from app.services import git_service

    result = await db.execute(select(SchemaPreset))
    moved = 0
    for preset in result.scalars().all():
        if preset.id and preset.preset_id and preset.id != preset.preset_id:
            if git_service.rename_repo("schema-presets", preset.preset_id, preset.id):
                moved += 1
    return moved


async def save(db: AsyncSession, data: SchemaPresetSave) -> SchemaPreset:
    """Upsert, keyed on `id` and falling back to `preset_id`.

    `id` is looked up first because it is the primary key: two rows may share a
    `preset_id` once it stops being an identity, and resolving by it would then
    overwrite the wrong one. A client that predates the split sends no `id`, so
    `preset_id` still resolves for it.

    The whole payload is applied on both branches so a git-link save (which comes
    through this PUT, not a PATCH) persists git_remote_config; git_secret strips
    and encrypts any authToken. The earlier update branch dropped git_remote_config.
    """
    payload = data.model_dump()
    preset = await get(db, data.id or data.preset_id)
    if preset is None:
        # A None created_at (fresh create / legacy file) must not override the
        # DateTime column's server_default with NULL — drop it so it stamps now.
        if payload.get("created_at") is None:
            payload.pop("created_at", None)
        preset = SchemaPreset()
        git_secret.apply_to_entity(preset, payload)
        for key, value in payload.items():
            setattr(preset, key, value)
        # `id` is the primary key now, so a client that predates the split (or a
        # hand-built payload) would insert NULL and fail. Falling back to
        # preset_id matches what the migration backfilled for existing rows.
        if not preset.id:
            preset.id = preset.preset_id
        if not preset.entity_id:
            preset.entity_id = preset.preset_id
        db.add(preset)
    else:
        git_secret.apply_to_entity(preset, payload)
        # Neither identity is reassignable on update: `id` is the PK, and
        # `preset_id` is what URLs, exports and on-disk repos still name.
        payload.pop("preset_id", None)
        payload.pop("id", None)
        # created_at is the element's original creation date, so an ordinary
        # re-save (which sends none) must not move it. An import DOES carry one —
        # the repo's provenance — and dropping it unconditionally left the local
        # row stamped with the moment it first appeared here, which then exported
        # back as a false creation date. See createdat-git-roundtrip: same bug,
        # fixed for the *Update schemas but this upsert PUT was not covered.
        if payload.get("created_at") is None:
            payload.pop("created_at", None)
        # Same reasoning for the lineage: it is the row's cross-instance identity, so
        # a client that sends none (an ordinary edit, or an older client) must not
        # clear the one already stored — that would make the entity unrecognisable to
        # every other instance holding a copy.
        # `id` and `entity_id` join them: both are minted once and then carried
        # unchanged, and a client that predates them sends neither. Clearing a
        # stored value here would undo the very migration that populates them.
        for key in ("lineage_id", "parent_lineage_id", "entity_id"):
            if payload.get(key) is None:
                payload.pop(key, None)
        for key, value in payload.items():
            setattr(preset, key, value)
    await db.commit()
    await db.refresh(preset)
    return preset


async def delete(db: AsyncSession, preset: SchemaPreset) -> None:
    from app.services import git_service

    # Attachments and the repo dir are keyed by the entity key, which is `id`
    # since revision e6f7a8b9c0d1. `preset_id` is cleaned up too: a row created
    # before the move owns its attachments and its repo under that name, and
    # they equal each other anyway wherever the backfill ran.
    keys = {k for k in (preset.id, preset.preset_id) if k}
    await db.delete(preset)
    await db.commit()
    for key in keys:
        # The README attachments' owner is polymorphic (no FK), so clean them here.
        await attachment_service.delete_readme_for_owner(db, "schema-preset", key)
        # Remove the on-disk versioning working tree so it doesn't linger as an orphan.
        git_service.remove_repo("schema-presets", key)
