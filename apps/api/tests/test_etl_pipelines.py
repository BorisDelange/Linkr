from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _create_user(db, client, username: str) -> dict:
    db.add(User(username=username, password_hash=hash_password("pw"), role="user"))
    await db.commit()
    r = await client.post(
        f"{API}/auth/login", json={"username": username, "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _workspace(client, headers) -> str:
    return (
        await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})
    ).json()["id"]


async def _pipeline(client, headers, ws: str, pid="p1") -> dict:
    return (await client.post(f"{API}/etl-pipelines", headers=headers, json={
        "id": pid, "workspaceId": ws, "name": {"en": "ETL"}, "description": {},
        "sourceDataSourceId": "src-1",
    })).json()


async def test_pipeline_crud(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    assert p["workspaceId"] == ws and p["name"]["en"] == "ETL"
    assert p["status"] == "draft" and p["sourceDataSourceId"] == "src-1"

    listed = (await client.get(f"{API}/etl-pipelines?workspaceId={ws}", headers=headers)).json()
    assert [x["id"] for x in listed] == [p["id"]]

    r = await client.patch(f"{API}/etl-pipelines/{p['id']}", headers=headers,
                           json={"status": "ready", "targetDataSourceId": "tgt-1"})
    assert r.json()["status"] == "ready" and r.json()["targetDataSourceId"] == "tgt-1"

    assert (await client.delete(f"{API}/etl-pipelines/{p['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/etl-pipelines/{p['id']}", headers=headers)).status_code == 404


async def test_versioning_marks_round_trip(client):
    """Per-file versioning marks survive a PATCH and a re-read.

    They decide what the git export commits — a pipeline's data files hold a
    mapping dictionary that may be private — so losing them silently would
    publish rows the user marked as not-for-git."""
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    # Absent by default: an unmarked pipeline behaves exactly as before.
    assert p.get("config") is None

    config = {
        "versionedDataFiles": ["mapping/source_to_concept_map.csv"],
        "excludedFiles": ["scratch.sql"],
    }
    r = await client.patch(
        f"{API}/etl-pipelines/{p['id']}", headers=headers, json={"config": config}
    )
    assert r.status_code == 200
    assert r.json()["config"] == config

    reread = (await client.get(f"{API}/etl-pipelines/{p['id']}", headers=headers)).json()
    assert reread["config"] == config

    # An unrelated PATCH must not drop them (exclude_unset).
    await client.patch(f"{API}/etl-pipelines/{p['id']}", headers=headers, json={"status": "ready"})
    kept = (await client.get(f"{API}/etl-pipelines/{p['id']}", headers=headers)).json()
    assert kept["config"] == config


async def test_list_all_without_workspace_filter(client):
    # The store loads pipelines app-wide (no workspaceId) — must not 422.
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await _pipeline(client, headers, ws)
    r = await client.get(f"{API}/etl-pipelines", headers=headers)
    assert r.status_code == 200
    assert len(r.json()) == 1


async def test_file_tree_crud_and_cascade(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)

    folder = (await client.post(f"{API}/etl-files", headers=headers, json={
        "id": "f1", "pipelineId": p["id"], "name": "steps", "type": "folder", "order": 0,
    })).json()
    file = (await client.post(f"{API}/etl-files", headers=headers, json={
        "id": "f2", "pipelineId": p["id"], "name": "01_load.sql", "type": "file",
        "parentId": folder["id"], "content": "SELECT 1", "language": "sql", "order": 1,
        "disabled": False,
    })).json()
    assert file["parentId"] == "f1" and file["content"] == "SELECT 1"
    assert file["language"] == "sql" and file["disabled"] is False

    files = (await client.get(f"{API}/etl-pipelines/{p['id']}/files", headers=headers)).json()
    assert {f["id"] for f in files} == {"f1", "f2"}

    r = await client.patch(f"{API}/etl-files/{file['id']}", headers=headers,
                           json={"content": "SELECT 2", "disabled": True})
    assert r.json()["content"] == "SELECT 2" and r.json()["disabled"] is True

    # Deleting the pipeline cascades to its files.
    assert (await client.delete(f"{API}/etl-pipelines/{p['id']}", headers=headers)).status_code == 204
    p2 = await _pipeline(client, headers, ws, pid="p2")
    assert (await client.get(f"{API}/etl-pipelines/{p2['id']}/files", headers=headers)).json() == []


async def test_delete_files_for_pipeline(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    await client.post(f"{API}/etl-files", headers=headers, json={
        "id": "f1", "pipelineId": p["id"], "name": "a.sql", "type": "file", "order": 0,
    })
    assert (await client.delete(f"{API}/etl-pipelines/{p['id']}/files", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/etl-pipelines/{p['id']}/files", headers=headers)).json() == []


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    p = await _pipeline(client, admin, ws)

    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/etl-pipelines?workspaceId={ws}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/etl-pipelines/{p['id']}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/etl-pipelines/{p['id']}", headers=other)).status_code == 403


# --- Run history -----------------------------------------------------------

async def test_run_history_crud_and_scripts_roundtrip(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)

    created = (await client.post(f"{API}/etl-runs", headers=headers, json={
        "id": "run-1", "pipelineId": p["id"], "startedAt": "2026-08-10T09:00:00Z",
        "status": "running",
        "scripts": [{"id": "l1", "pipelineId": p["id"], "fileId": "f1", "status": "running"}],
    })).json()
    assert created["id"] == "run-1" and created["status"] == "running"

    runs = (await client.get(f"{API}/etl-pipelines/{p['id']}/runs", headers=headers)).json()
    assert len(runs) == 1
    assert runs[0]["scripts"][0]["fileId"] == "f1"

    # Finishing the run: the per-script logs survive the round trip intact.
    done = (await client.patch(f"{API}/etl-runs/run-1", headers=headers, json={
        "status": "success", "completedAt": "2026-08-10T09:05:00Z",
        "scripts": [{"id": "l1", "pipelineId": p["id"], "fileId": "f1",
                     "status": "success", "rowsAffected": 42, "durationMs": 1200}],
    })).json()
    assert done["status"] == "success"
    assert done["scripts"][0]["rowsAffected"] == 42
    assert done["scripts"][0]["durationMs"] == 1200

    assert (await client.delete(f"{API}/etl-runs/run-1", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/etl-pipelines/{p['id']}/runs", headers=headers)).json() == []


async def test_runs_are_listed_newest_first(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    for i, at in enumerate(["2026-08-10T09:00:00Z", "2026-08-10T11:00:00Z", "2026-08-10T10:00:00Z"]):
        await client.post(f"{API}/etl-runs", headers=headers, json={
            "id": f"run-{i}", "pipelineId": p["id"], "startedAt": at, "status": "success",
        })
    runs = (await client.get(f"{API}/etl-pipelines/{p['id']}/runs", headers=headers)).json()
    assert [r["id"] for r in runs] == ["run-1", "run-2", "run-0"]


async def test_posting_the_same_run_id_updates_it(client):
    """The store re-sends a run as it progresses; that must not duplicate rows."""
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    for status_value in ("running", "success"):
        await client.post(f"{API}/etl-runs", headers=headers, json={
            "id": "run-1", "pipelineId": p["id"],
            "startedAt": "2026-08-10T09:00:00Z", "status": status_value,
        })
    runs = (await client.get(f"{API}/etl-pipelines/{p['id']}/runs", headers=headers)).json()
    assert len(runs) == 1 and runs[0]["status"] == "success"


async def test_run_records_who_launched_it(client, db):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    created = (await client.post(f"{API}/etl-runs", headers=headers, json={
        "id": "run-1", "pipelineId": p["id"],
        "startedAt": "2026-08-10T09:00:00Z", "status": "running",
    })).json()
    assert created["createdById"] is not None

    # Attribution is set once: a later tick must not reassign the run.
    again = (await client.post(f"{API}/etl-runs", headers=headers, json={
        "id": "run-1", "pipelineId": p["id"],
        "startedAt": "2026-08-10T09:00:00Z", "status": "success",
    })).json()
    assert again["createdById"] == created["createdById"]


async def test_clearing_the_history_removes_every_run(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    for i in range(3):
        await client.post(f"{API}/etl-runs", headers=headers, json={
            "id": f"run-{i}", "pipelineId": p["id"],
            "startedAt": f"2026-08-10T0{i}:00:00Z", "status": "success",
        })
    assert (await client.delete(f"{API}/etl-pipelines/{p['id']}/runs", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/etl-pipelines/{p['id']}/runs", headers=headers)).json() == []


async def test_history_is_capped_dropping_the_oldest(client):
    """A run is written on every progress tick, so the table must not grow forever."""
    from app.services.etl_pipeline_service import MAX_RUNS_PER_PIPELINE

    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    for i in range(MAX_RUNS_PER_PIPELINE + 3):
        await client.post(f"{API}/etl-runs", headers=headers, json={
            "id": f"run-{i:03d}", "pipelineId": p["id"],
            "startedAt": f"2026-08-10T{i // 60:02d}:{i % 60:02d}:00Z", "status": "success",
        })
    runs = (await client.get(f"{API}/etl-pipelines/{p['id']}/runs", headers=headers)).json()
    assert len(runs) == MAX_RUNS_PER_PIPELINE
    # The three oldest were dropped, the newest kept.
    assert runs[0]["id"] == f"run-{MAX_RUNS_PER_PIPELINE + 2:03d}"
    assert "run-000" not in [r["id"] for r in runs]


async def test_deleting_a_pipeline_takes_its_runs(client, db):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    await client.post(f"{API}/etl-runs", headers=headers, json={
        "id": "run-1", "pipelineId": p["id"],
        "startedAt": "2026-08-10T09:00:00Z", "status": "success",
    })
    assert (await client.delete(f"{API}/etl-pipelines/{p['id']}", headers=headers)).status_code == 204

    from sqlalchemy import select

    from app.models.etl_pipeline import EtlRunHistory

    rows = (await db.execute(select(EtlRunHistory))).scalars().all()
    assert list(rows) == []


async def test_run_writes_require_pipeline_access(client, db):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _pipeline(client, headers, ws)
    other = await _create_user(db, client, "mallory")

    # No pipelineId: rejected at validation, so there is no orphan-write path.
    assert (await client.post(f"{API}/etl-runs", headers=headers, json={
        "id": "run-x", "startedAt": "2026-08-10T09:00:00Z", "status": "running",
    })).status_code == 422

    # A non-member cannot write, read or clear another workspace's runs.
    assert (await client.post(f"{API}/etl-runs", headers=other, json={
        "id": "run-y", "pipelineId": p["id"],
        "startedAt": "2026-08-10T09:00:00Z", "status": "running",
    })).status_code in (403, 404)
    assert (await client.get(
        f"{API}/etl-pipelines/{p['id']}/runs", headers=other
    )).status_code in (403, 404)
    assert (await client.delete(
        f"{API}/etl-pipelines/{p['id']}/runs", headers=other
    )).status_code in (403, 404)
