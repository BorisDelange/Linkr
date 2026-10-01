"""core/audit: one line per data access, chained, compacted to Parquet, readable
through DuckDB — and written by the middleware without any route asking."""

import json
from datetime import date, timedelta

import pytest

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


def test_compaction_waits_for_a_write_in_flight():
    """A line begun just before midnight lands in yesterday's file; compaction
    must not read that file, then unlink it with the line inside."""
    import threading

    for i in range(2):
        audit.write({"user_id": 1, "action": "query", "detail": f"SELECT {i}"})
    [day] = _files("*.jsonl")
    first, late = day.read_text().splitlines(keepends=True)
    yesterday = day.with_name(f"{(date.today() - timedelta(days=1)).isoformat()}.jsonl")
    day.unlink()
    yesterday.write_text(first)

    with audit._writer.lock:
        worker = threading.Thread(target=audit.compact, args=(date.today(),))
        worker.start()
        worker.join(0.3)
        assert worker.is_alive()
        with open(yesterday, "a") as fh:
            fh.write(late)
    worker.join(10)

    assert _files("*.jsonl") == []
    assert audit.query()[1] == 2
    assert audit.verify()["ok"] is True


def test_a_missing_head_is_a_break_until_retention_explains_it():
    for i in range(3):
        audit.write({"user_id": 1, "action": "query", "detail": f"SELECT {i}"})
    [path] = _files("*.jsonl")
    path.write_text("".join(path.read_text().splitlines(keepends=True)[1:]))

    assert audit.verify() == {"ok": False, "checked": 0, "brokenAtSeq": 2}
    later = date.today() + timedelta(days=settings.audit_retention_days + 62)
    assert audit.verify(later) == {"ok": True, "checked": 2, "brokenAtSeq": None}


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
    assert audit.query(filters={"data_source_id": "a"})[1] == 1
    assert audit.query(filters={"action": ["run_code"]})[0][0]["user_id"] == 2
    assert audit.query(filters={"summary": "person"})[1] == 1


def test_sort_and_derived_columns():
    audit.write({"user_id": 1, "username": "zoe", "via": "job:abc", "method": "JOB", "route": "job", "status": 200})
    audit.write({"user_id": 2, "username": "amy", "via": "web", "action": "query", "detail": "SELECT 1", "status": 428})
    rows, _ = audit.query(sort="username", desc=False)
    assert [r["username"] for r in rows] == ["amy", "zoe"]
    assert rows[1]["via_kind"] == "job" and rows[1]["what"] == "JOB" and rows[1]["summary"] == "job"
    assert audit.query(filters={"via_kind": ["job"]})[1] == 1
    assert audit.query(filters={"status": ["428"]})[1] == 1
    assert audit.distinct_values(["username", "via_kind"]) == {"username": ["amy", "zoe"], "via_kind": ["job", "web"]}


def test_unknown_columns_never_reach_the_sql():
    audit.write({"user_id": 1, "action": "query"})
    assert audit.query(sort="seq; DROP TABLE x", filters={"1=1) OR (1": "x"})[1] == 1
    assert "nope" not in audit.distinct_values(["nope"])


def test_paging():
    for i in range(5):
        audit.write({"user_id": 1, "action": "query", "detail": str(i)})
    rows, total = audit.query(limit=2, offset=2)
    assert total == 5 and [r["seq"] for r in rows] == [3, 2]
    assert [r["seq"] for r in audit.query(sort="at", desc=False, limit=2)[0]] == [1, 2]


def test_export_is_every_matching_row(tmp_path):
    for i in range(3):
        audit.write({"user_id": 1, "username": "a" if i else "b", "action": "query"})
    out = tmp_path / "log.csv"
    assert audit.export_csv(out, filters={"username": ["a"]}) == 2
    lines = out.read_text().splitlines()
    assert lines[0].startswith("seq,at,") and "hash" not in lines[0] and len(lines) == 3


# --- Written by the middleware -------------------------------------------------

async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
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

    rows, _ = audit.query(filters={"action": ["query"]})
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
    rows, _ = audit.query(filters={"data_source_id": [source_id]})
    assert rows[0]["status"] == 428 and rows[0]["error"] == "no login for this database"


async def test_the_log_is_admin_only_but_own_activity_is_open(client, db):
    headers = await _admin(client)
    source_id = await _file_database(client, headers)
    await client.post(f"{API}/data-sources/{source_id}/query", headers=headers, json={"sql": "SELECT 1"})

    db.add(User(username="bob", password_hash=hash_password("pw-for-tests-only"), role="user"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": "bob", "password": "pw-for-tests-only"})
    bob = {"Authorization": f"Bearer {r.json()['access_token']}"}

    assert (await client.get(f"{API}/audit-log", headers=bob)).status_code == 403
    page = (await client.get(f"{API}/audit-log", headers=headers)).json()
    assert page["total"] >= 1 and "detail" in page["entries"][0]
    mine = (await client.get(f"{API}/auth/my-activity", headers=bob)).json()
    assert all(e["username"] == "bob" for e in mine["entries"])
    assert (await client.get(f"{API}/audit-log/verify", headers=headers)).json()["ok"] is True


async def test_routes_page_filter_and_export(client):
    headers = await _admin(client)
    source_id = await _file_database(client, headers)
    for sql in ("SELECT 1", "SELECT 2"):
        await client.post(f"{API}/data-sources/{source_id}/query", headers=headers, json={"sql": sql})

    import json as _json
    page = (await client.get(
        f"{API}/audit-log", headers=headers,
        params={"limit": 1, "sort": "seq", "desc": "true", "filters": _json.dumps({"what": ["query"]})},
    )).json()
    assert page["total"] == 2 and len(page["entries"]) == 1
    assert "query" in page["filterOptions"]["what"]
    assert (await client.get(f"{API}/audit-log", headers=headers, params={"filters": "[1]"})).status_code == 400

    r = await client.get(f"{API}/audit-log/export", headers=headers, params={"filters": _json.dumps({"what": ["query"]})})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert len(r.text.strip().splitlines()) == 3


# --- What reaches the log (security plan B1) ----------------------------------


@pytest.mark.parametrize("ctx, logged", [
    ({"method": "GET", "status": 200}, False),                        # UI polling
    ({"method": "GET", "status": 200, "action": "download"}, True),   # a file left
    ({"method": "POST", "status": 200, "action": "preview"}, True),   # rows were read
    ({"method": "GET", "status": 200, "action": "export"}, True),
    ({"method": "POST", "status": 200, "action": "login"}, True),
    ({"method": "POST", "status": 401, "action": "login_failed"}, True),
    ({"method": "POST", "status": 401}, True),                         # refused
    ({"method": "POST", "status": 200, "user_id": 1}, True),           # a change
    ({"method": "POST", "status": 200}, False),                        # anonymous POST
])
def test_worth_logging(ctx, logged):
    assert audit._worth_logging(ctx) is logged


def _lines(action: str) -> list[dict]:
    return audit.query(filters={"action": [action]})[0]


async def test_login_is_logged_by_username_success_and_failure(client):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    await client.post(f"{API}/auth/login", json={"username": "admin", "password": "wrong"})
    await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    failed, ok = _lines("login_failed"), _lines("login")
    assert [r["detail"] for r in failed] == ["admin"] and failed[0]["status"] == 401
    assert [r["username"] for r in ok] == ["admin"] and ok[0]["status"] == 200


async def test_downloads_exports_and_previews_are_logged(client):
    from app.services import project_fs

    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    token = (await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    ws = (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=h, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    csv_path = project_fs.dataset_path(uid, "d.csv")
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    csv_path.write_text("a,b\n1,x\n2,y\n")

    assert (await client.get(f"{API}/dataset-files/raw", headers=h, params={"projectUid": uid, "path": "d.csv"})).status_code == 200
    assert (await client.post(f"{API}/dataset-files/rows/query", headers=h, params={"projectUid": uid, "path": "d.csv"},
                              json={"offset": 0, "limit": 10})).status_code == 200
    assert (await client.get(f"{API}/projects/{uid}/export-zip", headers=h)).status_code == 200
    assert (await client.post(f"{API}/workspaces/{ws}/export-zip", headers=h, json={})).status_code == 200

    download = _lines("download")
    assert download[0]["project_uid"] == uid and "datasets/d.csv" in download[0]["detail"]
    preview = _lines("preview")
    assert preview[0]["row_count"] == 2 and preview[0]["username"] == "admin"
    exports = {(r["project_uid"], r["workspace_id"]) for r in _lines("export")}
    assert (uid, ws) in exports and (None, ws) in exports


def test_a_retention_of_zero_is_refused():
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError):
        Settings(audit_retention_days=0)
