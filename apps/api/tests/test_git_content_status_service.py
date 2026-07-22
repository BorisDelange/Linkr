"""git_content_status_service: the (scope, entity_id) row carries its owning
workspace, and a caller authorized on a DIFFERENT workspace can neither overwrite
nor clear it (entity ids are globally unique, so a row belongs to one workspace)."""

from app.services import git_content_status_service as svc


async def test_set_and_list_is_workspace_scoped(db):
    await svc.set_status(db, "sql-collection", "e1", "ws-a", "pending")
    await svc.set_status(db, "sql-collection", "e2", "ws-b", "failed")

    a = await svc.list_for_workspace(db, "ws-a")
    b = await svc.list_for_workspace(db, "ws-b")
    assert {r.entity_id for r in a} == {"e1"}
    assert {r.entity_id for r in b} == {"e2"}


async def test_set_status_cannot_overwrite_another_workspaces_row(db):
    # ws-a owns (sql-collection, e1). A ws-b caller passing the same (scope,
    # entity_id) must NOT overwrite or reparent it — the row stays ws-a's.
    await svc.set_status(db, "sql-collection", "e1", "ws-a", "pending")
    await svc.set_status(db, "sql-collection", "e1", "ws-b", "failed")

    rows = await svc.list_for_workspace(db, "ws-a")
    assert [(r.workspace_id, r.status) for r in rows] == [("ws-a", "pending")]
    assert await svc.list_for_workspace(db, "ws-b") == []


async def test_set_status_updates_own_row(db):
    await svc.set_status(db, "sql-collection", "e1", "ws-a", "pending")
    await svc.set_status(db, "sql-collection", "e1", "ws-a", "failed")

    rows = await svc.list_for_workspace(db, "ws-a")
    assert [r.status for r in rows] == ["failed"]


async def test_clear_only_removes_the_authorized_workspaces_row(db):
    await svc.set_status(db, "sql-collection", "e1", "ws-a", "pending")

    # A ws-b caller clears (sql-collection, e1): ws-a's row must survive.
    await svc.clear(db, "ws-b", "sql-collection", "e1")
    assert [r.entity_id for r in await svc.list_for_workspace(db, "ws-a")] == ["e1"]

    # The owning workspace can clear it.
    await svc.clear(db, "ws-a", "sql-collection", "e1")
    assert await svc.list_for_workspace(db, "ws-a") == []
