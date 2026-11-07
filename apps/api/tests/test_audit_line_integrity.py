"""Every access-log line stays readable, survives compaction and keeps the chain
verifying; what a line shortens can be read back in full; and the error column
never holds a row value, whatever shape the driver's message takes."""

import json
from datetime import date, datetime, timedelta, timezone

import duckdb
import pytest

from app.config import settings
from app.core import audit
from app.core.redact import log_safe_error
from app.core.security import hash_password
from app.models.role import Role
from app.models.user import User
from app.services.data import managed_db

API = "/api/v1"
VALUE = "DUMMY-PATIENT-NAME"


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _files(pattern: str):
    return sorted((settings.data_path / "audit").glob(pattern))


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# --- Lines that cannot be read back -------------------------------------------------

async def test_a_lone_surrogate_leaves_the_line_readable_and_the_chain_verifying(client):
    headers = await _admin(client)
    body = '{"codes": ["print(1) # \\ud800"]}'
    r = await client.post(f"{API}/code-acceptances", headers={**headers, "content-type": "application/json"},
                          content=body.encode())
    assert r.status_code == 204
    audit.write({"user_id": 1, "action": "query", "detail": "SELECT 1"})

    rows, _ = audit.query(filters={"route": "code-acceptances"})
    assert len(rows) == 1 and "print(1)" in rows[0]["detail"]
    assert audit.verify()["ok"] is True

    [day] = _files("*.jsonl")
    yesterday = (_today() - timedelta(days=1)).isoformat()
    day.rename(day.with_name(f"{yesterday}.jsonl"))
    audit.compact(_today())
    audit.reset()
    audit.write({"user_id": 1, "action": "query", "detail": "SELECT 2"})
    assert audit.query(filters={"route": "code-acceptances"})[1] == 1
    assert audit.verify()["ok"] is True


def test_verify_still_sees_an_edit_after_an_earlier_break():
    for i in range(6):
        audit.write({"user_id": 1, "action": "query", "detail": f"SELECT {i}"})
    [day] = _files("*.jsonl")
    lines = day.read_text().splitlines()
    first = json.loads(lines[1])
    first["user_id"] = 2
    lines[1] = json.dumps(first)
    day.write_text("\n".join(lines) + "\n")
    before = audit.verify()
    assert before["ok"] is False and before["brokenAtSeq"] == 2

    later = json.loads(lines[4])
    later["detail"] = "SELECT edited"
    lines[4] = json.dumps(later)
    day.write_text("\n".join(lines) + "\n")
    after = audit.verify()
    assert after["brokenAtSeq"] == 2 and 5 in after["brokenSeqs"]
    assert after != before


def test_compaction_keeps_a_line_it_cannot_read():
    for i in range(3):
        audit.write({"user_id": 1, "action": "query", "detail": f"SELECT {i}"})
    [day] = _files("*.jsonl")
    lines = day.read_text().splitlines()
    day.write_text("\n".join([lines[0], lines[1][:30] + "}", lines[2]]) + "\n")
    yesterday = (_today() - timedelta(days=1)).isoformat()
    day.rename(day.with_name(f"{yesterday}.jsonl"))

    audit.compact(_today())
    kept = _files(f"{yesterday}.jsonl.*.quarantine")
    assert len(kept) == 1 and lines[1][:30] in kept[0].read_text()


# --- Long statements ----------------------------------------------------------------------

def _bound(**fields) -> dict:
    token = audit._current.set({})
    try:
        audit.bind(**fields)
        return audit._current.get()
    finally:
        audit._current.reset(token)


@pytest.mark.parametrize("pad", ["/*" + "x" * 1200 + "*/", " " * 1200])
def test_a_statement_padded_at_both_ends_can_be_read_back_from_its_line(pad):
    statement = f"SELECT {pad} count(*) AS n FROM hidden_marker_tbl {pad}"
    detail = _bound(detail=statement)["detail"]
    assert "hidden_marker_tbl" not in detail
    digest = audit.detail_digest(detail)
    assert digest is not None
    assert audit.full_detail(digest) == statement


async def test_the_full_text_is_served_to_a_reader_of_the_log_only(client, db):
    headers = await _admin(client)
    statement = "SELECT " + " " * 1500 + "hidden_marker_tbl" + " " * 1500
    digest = audit.detail_digest(_bound(detail=statement)["detail"])

    r = await client.get(f"{API}/audit-log/details/{digest}", headers=headers)
    assert r.status_code == 200 and r.text == statement
    assert (await client.get(f"{API}/audit-log/details/{'0' * 64}", headers=headers)).status_code == 404
    assert (await client.get(f"{API}/audit-log/details/..%2Fsecret", headers=headers)).status_code in (404, 422)

    db.add(User(username="bob", password_hash=hash_password("pw-for-tests-only"), role="user"))
    await db.commit()
    bob = (await client.post(f"{API}/auth/login", json={"username": "bob", "password": "pw-for-tests-only"})).json()
    r = await client.get(f"{API}/audit-log/details/{digest}", headers={"Authorization": f"Bearer {bob['access_token']}"})
    assert r.status_code == 403


def test_full_texts_go_with_retention(monkeypatch):
    import os

    monkeypatch.setattr(settings, "audit_retention_days", 30)
    digest = audit.detail_digest(_bound(detail="x" * 5000)["detail"])
    path = audit._details_dir() / f"{digest}.txt.gz"
    old = datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp()
    os.utime(path, (old, old))
    audit._apply_retention(settings.data_path / "audit", _today())
    assert not path.exists()


# --- Errors ------------------------------------------------------------------------------

@pytest.mark.parametrize("message", [
    f'Invalid Input Error: Could not parse string "{VALUE}" according to format specifier "%Y"\n{VALUE}\n^\nError: Expected a number',
    f"Invalid Input Error: missing ): {VALUE}(",
    f"Invalid Input Error: {VALUE}",
    f"ERROR:  new row violates check constraint\nDETAIL:  Failing row contains (1, {VALUE}).",
    f"Violation of PRIMARY KEY constraint. The duplicate key value is ({VALUE}).",
    f"Conversion Error: Could not convert string '{VALUE}' to INT32",
    f"{VALUE}",
])
def test_a_failed_query_leaves_no_row_value_in_the_error_column(message):
    out = log_safe_error(message)
    assert VALUE not in out and "PATIENT" not in out


@pytest.mark.parametrize("message, kept", [
    ("Conversion Error: Could not convert string 'X' to INT32 when casting from source column name", "to INT32"),
    ('Binder Error: Referenced column "nope" not found in FROM clause!', 'column "nope" not found'),
    ("Catalog Error: Table with name nope does not exist!", "nope does not exist"),
    ("Invalid Input Error: Could not parse string", "Invalid Input Error"),
])
def test_an_error_keeps_its_class_and_value_free_shapes(message, kept):
    assert kept in log_safe_error(message)


async def test_an_auditor_reads_no_row_value_from_a_failed_query(client, db):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    source_id = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "db", "name": "db", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{source_id}/create-from-ddl", headers=headers,
                          json={"ddl": "CREATE TABLE person (id INTEGER, name VARCHAR);"})
    assert r.status_code == 200, r.text
    con = duckdb.connect(str(managed_db.path_for(source_id)))
    con.execute(f"INSERT INTO person VALUES (1, '{VALUE}')")
    con.close()

    for sql in ("select strptime(name,'%Y') from person", "select error(name) from person",
                "select regexp_matches('a',name||'(') from person"):
        r = await client.post(f"{API}/data-sources/{source_id}/query", headers=headers, json={"sql": sql})
        assert r.status_code >= 400

    db.add(Role(name="auditor", scope="global", permissions=["audit-log:read"]))
    db.add(User(username="auditor", password_hash=hash_password("pw-for-tests-only"), role="auditor"))
    await db.commit()
    login = (await client.post(f"{API}/auth/login", json={"username": "auditor", "password": "pw-for-tests-only"})).json()
    page = (await client.get(f"{API}/audit-log", params={"limit": 1000},
                             headers={"Authorization": f"Bearer {login['access_token']}"})).json()
    errors = [e["error"] for e in page["entries"] if e.get("error")]
    assert errors and all(VALUE not in e for e in errors)
