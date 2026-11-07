"""A preset's attachments and versioning tree belong to the one preset whose id
names them: a `presetId` naming another preset reaches none of its state."""

from app.config import settings
from app.models.schema_preset import SchemaPreset
from app.models.workspace import Workspace
from app.services import attachment_service, schema_preset_service
from app.services.workspace_export_assemble import build_schema_preset_tree
from tests.test_schema_presets import _admin_headers, _create_user, _make_workspace

API = "/api/v1"
VICTIM = "victim-preset-1"


async def _victim(db, workspace_id: str) -> None:
    db.add(SchemaPreset(id=VICTIM, preset_id=VICTIM, workspace_id=workspace_id, mapping={"tables": ["t"]}))
    await db.commit()
    await attachment_service.create_readme(
        db, id="victim-att-1", owner_type="schema-preset", owner_id=VICTIM, workspace_id=workspace_id,
        file_name="doc.png", mime_type="image/png", created_at=None, data=b"\x89PNG dummy",
    )
    tree = settings.data_path / "schema-presets" / VICTIM / "versioning"
    tree.mkdir(parents=True)
    (tree / "dummy.txt").write_text("dummy")


def _victim_tree():
    return settings.data_path / "schema-presets" / VICTIM / "versioning"


async def _victim_attachments(db) -> list[str]:
    db.expire_all()
    rows = await attachment_service.list_readme_by_owner(db, "schema-preset", VICTIM)
    return [r.id for r in rows]


async def _claiming_preset(client, db) -> tuple[dict, str, str]:
    admin = await _admin_headers(client)
    ws_victim = await _make_workspace(client, admin)
    await _victim(db, ws_victim)
    caller = await _create_user(db, client, "caller")
    ws_caller = await _make_workspace(client, caller)
    r = await client.put(f"{API}/schema-presets/claimer-1", headers=caller, json={
        "id": "claimer-1", "presetId": VICTIM, "workspaceId": ws_caller, "mapping": {"tables": ["t"]},
    })
    assert r.status_code == 200, r.text
    return caller, ws_caller, "claimer-1"


async def test_exporting_a_preset_carries_only_its_own_attachments(client, db):
    _, _, claimer = await _claiming_preset(client, db)
    preset = await db.get(SchemaPreset, claimer)
    tree = await build_schema_preset_tree(db, preset)
    assert not any(b"dummy" in v for v in tree.values())
    assert not any("doc.png" in k for k in tree)


async def test_a_preset_exports_attachments_stored_under_its_id(client, db):
    admin = await _admin_headers(client)
    ws = await _make_workspace(client, admin)
    db.add(SchemaPreset(id="uuid-like-id", preset_id="readable-slug", workspace_id=ws, mapping={"tables": []}))
    await db.commit()
    await attachment_service.create_readme(
        db, id="own-att", owner_type="schema-preset", owner_id="uuid-like-id", workspace_id=ws,
        file_name="own.png", mime_type="image/png", created_at=None, data=b"own bytes",
    )
    tree = await build_schema_preset_tree(db, await db.get(SchemaPreset, "uuid-like-id"))
    assert any(v == b"own bytes" for v in tree.values())


async def test_deleting_a_preset_leaves_another_preset_s_attachments_and_tree(client, db):
    caller, _, claimer = await _claiming_preset(client, db)
    assert (await client.delete(f"{API}/schema-presets/{claimer}", headers=caller)).status_code == 204
    assert await _victim_attachments(db) == ["victim-att-1"]
    assert (_victim_tree() / "dummy.txt").exists()


async def test_deleting_a_workspace_leaves_another_preset_s_tree(client, db):
    caller, ws_caller, _ = await _claiming_preset(client, db)
    assert (await client.delete(f"{API}/workspaces/{ws_caller}", headers=caller)).status_code == 204
    assert (_victim_tree() / "dummy.txt").exists()
    assert await _victim_attachments(db) == ["victim-att-1"]


async def test_startup_never_moves_a_tree_another_preset_holds(client, db):
    await _claiming_preset(client, db)
    assert await schema_preset_service.reconcile_repo_dirs(db) == 0
    assert (_victim_tree() / "dummy.txt").exists()
    assert not (settings.data_path / "schema-presets" / "claimer-1" / "versioning" / "dummy.txt").exists()


async def test_startup_still_moves_a_tree_named_after_its_own_preset_id(db):
    db.add(Workspace(id="ws-1", name={"en": "w"}))
    await db.commit()
    db.add(SchemaPreset(id="new-key", preset_id="old-key", workspace_id="ws-1", mapping={"tables": []}))
    await db.commit()
    old = settings.data_path / "schema-presets" / "old-key" / "versioning"
    old.mkdir(parents=True)
    (old / "f.txt").write_text("x")
    assert await schema_preset_service.reconcile_repo_dirs(db) == 1
    assert (settings.data_path / "schema-presets" / "new-key" / "versioning" / "f.txt").exists()


async def test_deleting_a_preset_still_removes_its_own_state(client, db):
    admin = await _admin_headers(client)
    ws = await _make_workspace(client, admin)
    await _victim(db, ws)
    assert (await client.delete(f"{API}/schema-presets/{VICTIM}", headers=admin)).status_code == 204
    assert await _victim_attachments(db) == []
    assert not _victim_tree().exists()
