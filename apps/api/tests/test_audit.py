"""core/audit: one line per data access, chained, compacted to Parquet, readable
through DuckDB — and written by the middleware without any route asking."""

import json
from datetime import date, timedelta

from app.config import settings
from app.core import audit
from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


def _files(pattern: str):
    return sorted((settings.data_path / "audit").glob(pattern))


def test_write_query_and_chain():
    for i in range(3):
        audit.write({"user_id": 1, "action": "query", "detail": f"SELECT {i}", "status": 200})
    rows, total = audit.query()
    assert total == 3
    assert [r["seq"] for r in rows] == [3, 2, 1]
    assert rows[0]["detail"] == "SELECT 2"
    assert audit.verify() == {"ok": True, "checked": 3, "brokenAtSeq": None}


def test_detail_is_truncated():
    token = audit._current.set({})
    try:
        audit.bind(detail="x" * 5000)
        assert len(audit._current.get()["detail"]) == 2000
    finally:
        audit._current.reset(token)


def test_edited_line_breaks_the_chain():
    for i in range(3):
        audit.write({"user_id": 1, "action": "query", "detail": f"SELECT {i}"})
    path = _files("*.jsonl")[0]
    lines = path.read_text().splitlines()
    tampered = json.loads(lines[1])
    tampered["user_id"] = 2
    lines[1] = json.dumps(tampered)
    path.write_text("\n".join(lines) + "\n")
    result = audit.verify()
    assert result["ok"] is False and result["brokenAtSeq"] == 2


def test_removed_line_breaks_the_chain():
    for i in range(3):
        audit.write({"user_id": 1, "action": "query", "detail": f"SELECT {i}"})
    path = _files("*.jsonl")[0]
    lines = path.read_text().splitlines()
    path.write_text("\n".join([lines[0], lines[2]]) + "\n")
    assert audit.verify()["ok"] is False


def test_compaction_keeps_entries_and_chain():
    for i in range(3):
        audit.write({"user_id": 1, "action": "query", "detail": f"SELECT {i}"})
    today = date.today()
    [day] = _files("*.jsonl")
    yesterday = today - timedelta(days=1)
    day.rename(day.with_name(f"{yesterday.isoformat()}.jsonl"))

    audit.compact(today)
    assert _files("*.jsonl") == []
    assert [p.name for p in _files("*.parquet")] == [f"{yesterday.isoformat()[:7]}.parquet"]

    # The chain carries on after a restart that only has the Parquet to read.
    audit.reset()
    audit.write({"user_id": 1, "action": "query", "detail": "SELECT 3"})
    rows, total = audit.query()
    assert total == 4 and rows[0]["seq"] == 4
    assert audit.verify()["ok"] is True


def test_compaction_appends_to_an_existing_month(monkeypatch):
    today = date(2026, 9, 25)
    for day in ("2026-09-20", "2026-09-21"):
        audit.write({"user_id": 1, "action": "query", "detail": day})
        [path] = _files("*.jsonl")
        path.rename(path.with_name(f"{day}.jsonl"))
        audit.compact(today)
    rows, total = audit.query()
    assert total == 2
    assert audit.verify()["ok"] is True


def test_retention_drops_old_months(monkeypatch):
    monkeypatch.setattr(settings, "audit_retention_days", 30)
    root = settings.data_path / "audit"
    root.mkdir(parents=True, exist_ok=True)
    (root / "2026-01.parquet").write_bytes(b"")
    (root / "2026-09.parquet").write_bytes(b"")
    audit._apply_retention(root, date(2026, 9, 25))
    assert [p.name for p in _files("*.parquet")] == ["2026-09.parquet"]


def test_filters():
    audit.write({"user_id": 1, "action": "query", "data_source_id": "a", "detail": "SELECT person"})
    audit.write({"user_id": 2, "action": "run_code", "detail": "print(1)"})
    assert audit.query(user_id=2)[1] == 1
    assert audit.query(data_source_id="a")[1] == 1
    assert audit.query(action="run_code")[0][0]["user_id"] == 2
    assert audit.query(text="person")[1] == 1


# --- Written by the middleware -------------------------------------------------

async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _file_database(client, headers) -> str:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    return (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "d", "name": "D", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })).json()["id"]


async def test_a_query_is_logged_with_who_what_and_outcome(client):
    headers = await _admin(client)
    source_id = await _file_database(client, headers)
    await client.post(f"{API}/data-sources/{source_id}/query", headers=headers, json={"sql": "SELECT 42"})

    rows, _ = audit.query(action="query")
    assert len(rows) == 1
    entry = rows[0]
    assert entry["username"] == "admin" and entry["via"] == "web"
    assert entry["data_source_id"] == source_id and entry["detail"] == "SELECT 42"
    assert entry["status"] == 400 and entry["route"].endswith("/query")


async def test_reads_without_data_are_not_logged(client):
    headers = await _admin(client)
    source_id = await _file_database(client, headers)
    before = audit.query()[1]
    await client.get(f"{API}/data-sources/{source_id}", headers=headers)
    await client.get(f"{API}/health")
    assert audit.query()[1] == before


async def test_a_missing_login_is_logged_as_refused(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    source_id = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "pg", "name": "PG", "sourceType": "database",
        "connectionConfig": {"engine": "postgresql", "host": "h"},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{source_id}/query", headers=headers, json={"sql": "SELECT 1"})
    assert r.status_code == 428
    rows, _ = audit.query(data_source_id=source_id)
    assert rows[0]["status"] == 428 and rows[0]["error"] == "no login for this database"


async def test_the_log_is_admin_only_but_own_activity_is_open(client, db):
    headers = await _admin(client)
    source_id = await _file_database(client, headers)
    await client.post(f"{API}/data-sources/{source_id}/query", headers=headers, json={"sql": "SELECT 1"})

    db.add(User(username="bob", password_hash=hash_password("pw"), role="user"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": "bob", "password": "pw"})
    bob = {"Authorization": f"Bearer {r.json()['access_token']}"}

    assert (await client.get(f"{API}/audit-log", headers=bob)).status_code == 403
    page = (await client.get(f"{API}/audit-log", headers=headers)).json()
    assert page["total"] >= 1 and "detail" in page["entries"][0]
    mine = (await client.get(f"{API}/auth/my-activity", headers=bob)).json()
    assert all(e["username"] == "bob" for e in mine["entries"])
    assert (await client.get(f"{API}/audit-log/verify", headers=headers)).json()["ok"] is True
