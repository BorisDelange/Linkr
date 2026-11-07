"""core/audit: one line per data access, chained, compacted to Parquet, readable
through DuckDB — and written by the middleware without any route asking."""

import errno
import json
import os
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.config import settings
from app.core import audit
from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


def _today() -> date:
    """The day the log's files are named after, which is UTC's."""
    return datetime.now(timezone.utc).date()


def _files(pattern: str):
    return sorted((settings.data_path / "audit").glob(pattern))


def test_write_query_and_chain():
    for i in range(3):
        audit.write({"user_id": 1, "action": "query", "detail": f"SELECT {i}", "status": 200})
    rows, total = audit.query()
    assert total == 3
    assert [r["seq"] for r in rows] == [3, 2, 1]
    assert rows[0]["detail"] == "SELECT 2"
    assert audit.verify() == {"ok": True, "checked": 3, "brokenAtSeq": None, "brokenSeqs": []}


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


def test_lines_from_before_the_request_id_still_verify():
    path = settings.data_path / "audit" / f"{_today().isoformat()}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    prev = audit._GENESIS
    with path.open("w") as f:
        for seq in (1, 2):
            old = {k: None for k in audit.COLUMNS if k not in ("hash", "request_id")}
            old.update(seq=seq, at=f"{_today().isoformat()}T00:00:0{seq}.000+00:00", action="query")
            body = json.dumps(old, sort_keys=True, default=str)
            prev = audit._line_hash(prev, body)
            f.write(json.dumps({**old, "hash": prev}) + "\n")
    audit._writer.state = None
    audit.write({"user_id": 1, "action": "query", "request_id": "abc123"})
    assert audit.verify() == {"ok": True, "checked": 3, "brokenAtSeq": None, "brokenSeqs": []}

    lines = path.read_text().splitlines()
    tampered = json.loads(lines[2])
    tampered["request_id"] = "other"
    lines[2] = json.dumps(tampered)
    path.write_text("\n".join(lines) + "\n")
    assert audit.verify()["brokenAtSeq"] == 3


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
    today = _today()
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
    yesterday = day.with_name(f"{(_today() - timedelta(days=1)).isoformat()}.jsonl")
    day.unlink()
    yesterday.write_text(first)

    with audit._writer.lock:
        worker = threading.Thread(target=audit.compact, args=(_today(),))
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

    assert audit.verify() == {"ok": False, "checked": 0, "brokenAtSeq": 2, "brokenSeqs": [2]}
    later = _today() + timedelta(days=settings.audit_retention_days + 62)
    assert audit.verify(later) == {"ok": True, "checked": 2, "brokenAtSeq": None, "brokenSeqs": []}


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
    assert rows[0]["request_id"] == r.headers["x-request-id"]


async def test_an_unhandled_error_answers_its_reference(client, monkeypatch):
    headers = await _admin(client)

    def boom(*args, **kwargs):
        raise RuntimeError("internal detail")

    monkeypatch.setattr(audit, "query", boom)
    r = await client.get(f"{API}/audit-log", headers=headers)
    rid = r.headers["x-request-id"]
    assert r.status_code == 500 and r.json()["detail"] == f"Internal server error (ref. {rid})"


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


async def test_ide_working_dir_reads_are_logged(client):
    from app.services import project_fs

    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    token = (await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    ws = (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=h, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    out = project_fs.ide_dir(uid) / "out.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("a\n1\n")

    assert (await client.get(f"{API}/ide-files/raw", headers=h, params={"projectUid": uid, "path": "out.csv"})).status_code == 200
    assert (await client.get(f"{API}/ide-files", headers=h, params={"projectUid": uid})).status_code == 200

    [download] = _lines("download")
    assert download["project_uid"] == uid and "ide/out.csv" in download["detail"]
    assert [r["project_uid"] for r in _lines("preview")] == [uid]


def test_a_retention_of_zero_is_refused():
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError):
        Settings(audit_retention_days=0)


async def test_attachment_scores_and_clone_downloads_are_logged(client, db, tmp_path):
    import subprocess

    from app.models.mapping_project import MappingProject
    from app.services import blob_store

    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    token = (await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    ws = (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=h, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]

    png = b"\x89PNG\r\n\x1a\nbytes"
    await client.post(f"{API}/readme-attachments?id=a1&ownerType=project&ownerId={uid}&fileName=r.png&mimeType=image/png",
                      headers=h, content=png)
    page = (await client.post(f"{API}/wiki-pages", headers=h, json={
        "id": "w1", "workspaceId": ws, "parentId": None, "title": {"en": "Page"},
        "slug": "page", "content": {"en": ""}, "sortOrder": 0,
    })).json()["id"]
    await client.post(f"{API}/wiki-attachments?id=wa1&pageId={page}&workspaceId={ws}&fileName=w.png&mimeType=image/png",
                      headers=h, content=png)
    assert (await client.get(f"{API}/readme-attachments/a1/blob", headers=h)).status_code == 200
    assert (await client.get(f"{API}/wiki-attachments/wa1/blob", headers=h)).status_code == 200

    await client.post(f"{API}/mapping-projects", headers=h, json={
        "id": "mp1", "workspaceId": ws, "name": {"en": "M"}, "description": {},
        "sourceType": "database", "dataSourceId": "src-1", "conceptSetIds": [],
    })
    sha, _ = await blob_store.store_bytes(b"PAR1scores")
    mp = await db.get(MappingProject, "mp1")
    mp.scores_file_sha = sha
    await db.commit()
    assert (await client.get(f"{API}/mapping-projects/mp1/scores-file", headers=h)).status_code == 200

    repo = tmp_path / "remote"
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
    (repo / "f.txt").write_text("x")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "c"], check=True)
    r = await client.post(f"{API}/git/clone", headers=h, json={"url": str(repo), "branch": "main", "workspaceId": ws})
    assert r.status_code == 200

    details = [d["detail"] for d in _lines("download")]
    assert any("README attachment r.png (" in d for d in details)
    assert any("wiki attachment w.png (" in d for d in details)
    assert any("mapping project mp1 scores file (10 bytes)" == d for d in details)
    assert any(d.startswith(f"git clone {repo} (") for d in details)
    assert all(d["workspace_id"] == ws for d in _lines("download"))


def test_a_logged_clone_url_carries_no_credentials():
    from app.api.v1.routes.git import _without_credentials

    assert _without_credentials("https://oauth2:glpat-x@gitlab.chu.local:8443/g/r.git") == "https://gitlab.chu.local:8443/g/r.git"
    assert _without_credentials("https://framagit.org/g/r.git") == "https://framagit.org/g/r.git"
    assert _without_credentials("git@framagit.org:g/r.git") == "git@framagit.org:g/r.git"
    assert _without_credentials("https://oauth2:tok@[fd00::1]:8443/g/r.git") == "https://[fd00::1]:8443/g/r.git"
    assert _without_credentials("https://gitlab.chu.local/g/r.git?private_token=glpat-x#frag") == "https://gitlab.chu.local/g/r.git"


# --- When the local file cannot be written ---------------------------------------

@pytest.fixture
def stdout_copy(monkeypatch) -> list[dict]:
    lines: list[dict] = []
    monkeypatch.setattr(audit, "_logger", SimpleNamespace(
        info=lambda event, **fields: lines.append(fields),
        exception=lambda event, **fields: None,
    ))
    return lines


def _disk_full(monkeypatch, written_before_failing: int = 0) -> None:
    real = os.write
    budget = {"left": written_before_failing}

    def write(fd, data):
        if budget["left"] <= 0:
            raise OSError(errno.ENOSPC, "No space left on device")
        n = real(fd, bytes(data)[: budget["left"]])
        budget["left"] -= n
        return n

    monkeypatch.setattr(audit.os, "write", write)


def test_a_full_disk_still_gives_the_collector_who_did_what(monkeypatch, stdout_copy):
    _disk_full(monkeypatch)
    audit.write({"user_id": 7, "username": "dummy", "action": "preview", "route": "/r", "detail": "datasets/d.csv"})
    [line] = stdout_copy
    assert line["user_id"] == 7 and line["action"] == "preview" and line["route"] == "/r"
    assert line["local_log"] == "failed" and line["at"]


def test_a_line_cut_by_a_full_disk_leaves_the_file_whole_and_the_chain_verifying(monkeypatch):
    audit.write({"user_id": 1, "action": "query", "detail": "before"})
    with monkeypatch.context() as full:
        _disk_full(full, written_before_failing=20)
        audit.write({"user_id": 1, "action": "query", "detail": "during"})
    [day] = _files("*.jsonl")
    assert day.read_bytes().endswith(b"\n") and len(day.read_text().splitlines()) == 1

    audit.write({"user_id": 1, "action": "query", "detail": "after"})
    assert audit.verify()["ok"] is True
    rows, total = audit.query(sort="seq", desc=False)
    assert total == 3 and [r["detail"] for r in rows if r["action"] == "query"] == ["before", "after"]


def test_lines_the_file_missed_are_stated_in_the_chain(monkeypatch, stdout_copy):
    audit.write({"user_id": 1, "action": "query"})
    with monkeypatch.context() as full:
        _disk_full(full)
        for _ in range(3):
            audit.write({"user_id": 1, "action": "query"})
    stdout_copy.clear()
    audit.write({"user_id": 1, "action": "query"})
    [gap] = audit.query(filters={"action": ["audit_gap"]})[0]
    assert gap["detail"].startswith("3 ")
    assert [e["action"] for e in stdout_copy] == ["audit_gap", "query"]
    assert audit.verify() == {"ok": True, "checked": 3, "brokenAtSeq": None, "brokenSeqs": []}


def test_a_write_the_system_cuts_short_is_finished(monkeypatch):
    real = os.write
    monkeypatch.setattr(audit.os, "write", lambda fd, data: real(fd, bytes(data)[:7]))
    audit.write({"user_id": 1, "action": "query", "detail": "SELECT 1"})
    monkeypatch.undo()
    assert audit.query()[0][0]["detail"] == "SELECT 1"
    assert audit.verify()["ok"] is True


@pytest.mark.parametrize("tail", [b'{"seq": 3, "at": "2026', b"not json\n", b'{"seq": 3}\n'], ids=["cut", "garbage", "no-hash"])
def test_a_damaged_tail_never_stops_the_log_after_a_restart(tail):
    for i in range(2):
        audit.write({"user_id": 1, "action": "query", "detail": f"SELECT {i}"})
    [day] = _files("*.jsonl")
    whole = day.read_bytes()
    day.write_bytes(whole + tail)

    audit.reset()
    audit.write({"user_id": 1, "action": "query", "detail": "SELECT 2"})

    assert day.read_bytes().startswith(whole)
    assert audit.verify() == {"ok": True, "checked": 4, "brokenAtSeq": None, "brokenSeqs": []}
    [note] = audit.query(filters={"action": ["audit_tail_set_aside"]})[0]
    [kept] = list(day.parent.glob("*.quarantine"))
    assert kept.read_bytes() == tail and kept.name in note["detail"]
    assert audit.query(sort="seq")[0][0]["detail"] == "SELECT 2"


def test_a_damaged_tail_is_found_under_a_line_longer_than_the_read_window():
    audit.write({"user_id": 1, "action": "query", "detail": "SELECT 0"})
    [day] = _files("*.jsonl")
    day.write_bytes(day.read_bytes() + b'{"seq": 2, "detail": "' + b"x" * (128 * 1024))
    audit.reset()
    audit.write({"user_id": 1, "action": "query", "detail": "SELECT 1"})
    assert audit.verify()["ok"] is True
    assert [r["seq"] for r in audit.query(sort="seq", desc=False)[0]] == [1, 2, 3]


def test_a_damaged_line_inside_a_day_leaves_the_rest_readable_and_shows_as_a_break():
    for i in range(3):
        audit.write({"user_id": 1, "action": "query", "detail": f"SELECT {i}"})
    [day] = _files("*.jsonl")
    lines = day.read_text().splitlines()
    day.write_text("\n".join([lines[0], lines[1][:30], lines[2]]) + "\n")

    assert audit.query()[1] == 2
    assert audit.verify() == {"ok": False, "checked": 1, "brokenAtSeq": 3, "brokenSeqs": [3]}


def test_compaction_folds_a_day_with_a_damaged_tail_after_a_restart():
    for i in range(2):
        audit.write({"user_id": 1, "action": "query", "detail": f"SELECT {i}"})
    [day] = _files("*.jsonl")
    today = _today()
    yesterday = day.with_name(f"{(today - timedelta(days=1)).isoformat()}.jsonl")
    day.rename(yesterday)
    with yesterday.open("ab") as f:
        f.write(b'{"seq": 3, "at"')

    audit.reset()
    audit.compact(today)
    assert _files("*.jsonl") == []
    audit.write({"user_id": 1, "action": "query", "detail": "SELECT 2"})
    assert audit.verify()["ok"] is True
    assert audit.query(filters={"action": ["audit_tail_set_aside"]})[1] == 1


def test_a_set_aside_tail_goes_with_retention(monkeypatch):
    monkeypatch.setattr(settings, "audit_retention_days", 30)
    root = settings.data_path / "audit"
    root.mkdir(parents=True, exist_ok=True)
    old = root / "2020-01-02.jsonl.1.quarantine"
    recent = root / f"{_today().isoformat()}.jsonl.2.quarantine"
    old.write_bytes(b"x")
    recent.write_bytes(b"x")
    audit.compact(_today())
    assert not old.exists() and recent.exists()


# --- Exports, long statements, values in errors -----------------------------------

def test_export_writes_log_text_as_text_and_leaves_the_log_alone(tmp_path):
    import csv

    planted = {
        "detail": "=SUM(1,2)", "username": "@you", "error": "+1+1", "client": "-1-1", "action": "\tx", "route": "\ry",
    }
    audit.write({"user_id": 1, "status": 200, **planted})
    audit.write({"user_id": 1, "status": 200, "detail": "SELECT 1", "action": "query", "username": "alice", "route": "/api/x"})
    out = tmp_path / "log.csv"
    assert audit.export_csv(out) == 2
    second, first = list(csv.DictReader(out.open(newline="")))
    for column, value in planted.items():
        assert first[column] == "'" + value
    assert (second["detail"], second["username"], second["route"]) == ("SELECT 1", "alice", "/api/x")
    stored, _ = audit.query(sort="seq", desc=False)
    assert stored[0]["detail"] == "=SUM(1,2)"
    assert audit.verify()["ok"] is True


def _bound(**fields) -> dict:
    token = audit._current.set({})
    try:
        audit.bind(**fields)
        return audit._current.get()
    finally:
        audit._current.reset(token)


def test_a_long_detail_keeps_both_ends_and_names_the_whole():
    import hashlib

    statement = "/*" + "x" * 3000 + "*/ SELECT name FROM person"
    detail = _bound(detail=statement)["detail"]
    assert len(detail) <= 2000
    assert detail.startswith("/*x") and detail.endswith("SELECT name FROM person")
    assert hashlib.sha256(statement.encode()).hexdigest() in detail
    assert f"{len(statement):,}" in detail
    assert _bound(detail="SELECT 1")["detail"] == "SELECT 1"


def test_a_value_quoted_by_an_error_stays_out_of_the_log():
    error = _bound(error="Conversion Error: Could not convert string 'DUMMY-NAME' to INT32")["error"]
    assert "DUMMY-NAME" not in error
    assert error.startswith("Conversion Error") and "INT32" in error


async def test_a_failing_block_keeps_values_out_of_its_line():
    with pytest.raises(ValueError):
        with audit.event_scope(action="query"):
            raise ValueError("Conversion Error: Could not convert string 'DUMMY-NAME' to INT32")
    rows, _ = audit.query()
    assert "DUMMY-NAME" not in rows[0]["error"] and "Conversion Error" in rows[0]["error"]


async def test_exporting_the_log_writes_a_line_of_its_own(client):
    headers = await _admin(client)
    assert (await client.get(f"{API}/audit-log/export", headers=headers)).status_code == 200
    rows, _ = audit.query(filters={"what": ["export"]})
    assert any(r["route"].endswith("/audit-log/export") for r in rows)


async def test_a_query_on_the_app_database_logs_its_statement(client):
    headers = await _admin(client)
    r = await client.post(f"{API}/database/query", headers=headers, json={"sql": "SELECT 41 + 1 AS n"})
    assert r.status_code == 200
    rows, _ = audit.query(filters={"route": "database/query"})
    assert rows[0]["detail"] == "SELECT 41 + 1 AS n" and rows[0]["row_count"] == 1
