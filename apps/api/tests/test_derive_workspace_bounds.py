"""A derivation stays inside its source's workspace, and a kept pseudonym key
serves, and is changed or removed by, its own workspace's derivations only."""

import base64

import pytest
from sqlalchemy import select

from app.config import settings
from app.core import crypto
from app.core.security import hash_password
from app.models.pseudonym_key import PseudonymKey
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from tests.test_cohort_derive_routes import API, MEMBERSHIP, _admin, _derive, _managed

KEY = base64.b64encode(b"k" * 32).decode("ascii")


async def _workspace(client, headers, name: str) -> str:
    return (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": name}})).json()["id"]


async def _member(client, db, username: str, roles: dict[str, str]) -> dict:
    user = User(username=username, password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(user)
    await db.flush()
    for ws, role in roles.items():
        db.add(WorkspaceMember(workspace_id=ws, user_id=user.id, role=role))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _store_key(db, name: str, workspace_id: str) -> str:
    sealed = crypto.encrypt(KEY, f"pseudonym-key:{name}")
    db.add(PseudonymKey(id=name, workspace_id=workspace_id, sealed_key=sealed))
    await db.commit()
    return sealed


async def _key(db, name: str) -> PseudonymKey | None:
    db.expire_all()
    return (await db.execute(select(PseudonymKey).where(PseudonymKey.id == name))).scalar_one_or_none()


async def _count(client, headers, ds: str) -> int:
    r = await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT COUNT(*) AS n FROM person"})
    return r.json()["rows"][0]["n"] if r.status_code == 200 else -1


@pytest.mark.parametrize("kind", ["new-database", "schema"])
async def test_a_derivation_never_lands_in_another_workspace(client, db, kind):
    admin = await _admin(client)
    ws_a, ws_b = await _workspace(client, admin, "A"), await _workspace(client, admin, "B")
    src = await _managed(client, admin, ws_a, "src", seed=True)
    both = await _member(client, db, "both", {ws_a: "viewer", ws_b: "editor"})
    dst = await _managed(client, both, ws_b, "dst", seed=kind == "schema")
    target = {"kind": kind, "dataSourceId": dst, **({"schemaName": "copied"} if kind == "schema" else {})}

    r = await client.post(f"{API}/data-sources/{src}/derive", headers=both, json={
        "membershipSql": MEMBERSHIP, "level": "patient", "target": target,
    })

    assert r.status_code == 400, r.text
    assert "another workspace" in r.json()["detail"]
    if kind == "schema":
        q = await client.post(f"{API}/data-sources/{dst}/query", headers=admin, json={"sql": "SELECT COUNT(*) AS n FROM copied.person"})
        assert q.status_code != 200
    else:
        assert await _count(client, admin, dst) == -1


async def test_a_derivation_into_its_own_workspace_still_runs(client, db):
    admin = await _admin(client)
    ws = await _workspace(client, admin, "A")
    src = await _managed(client, admin, ws, "src", seed=True)
    editor = await _member(client, db, "editor", {ws: "editor"})
    dst = await _managed(client, editor, ws, "dst", seed=False)
    job = await _derive(client, editor, ws, src, {
        "membershipSql": MEMBERSHIP, "level": "patient", "target": {"kind": "new-database", "dataSourceId": dst},
    })
    assert job["status"] == "done", job
    assert await _count(client, admin, dst) == 5


async def _named_like_a_key(client, headers, ws: str, name: str, tmp_path, monkeypatch) -> str:
    """A database of `ws` whose chosen id is `name`, made before any key holds it."""
    monkeypatch.setattr(settings, "fs_browse_roots", str(tmp_path))
    r = await client.post(f"{API}/data-sources", headers=headers, json={
        "id": name, "workspaceId": ws, "alias": "lookalike", "name": {"en": "l"}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"}, "schemaMapping": {"patientTable": {"table": "person", "idColumn": "person_id"}},
    })
    assert r.status_code == 201, r.text
    r = await client.post(f"{API}/data-sources/{name}/create-from-ddl", headers=headers, json={
        "ddl": "", "path": str(tmp_path / "lookalike.duckdb"),
    })
    assert r.status_code == 200, r.text
    return name


@pytest.mark.parametrize("pseudonymization", [
    {"method": "hmac"},
    {"method": "hmac", "keepKey": False},
    {"method": "random"},
    None,
    "reuse",
])
async def test_a_kept_key_is_never_drawn_replaced_or_removed_from_another_workspace(
    client, db, tmp_path, monkeypatch, pseudonymization,
):
    admin = await _admin(client)
    ws_victim, ws_caller = await _workspace(client, admin, "V"), await _workspace(client, admin, "R")
    editor = await _member(client, db, "editor", {ws_caller: "editor"})
    src = await _managed(client, editor, ws_caller, "candidates", seed=True)
    name = "c1b2c3d4-0000-4000-8000-000000000003.pseudo"
    await _named_like_a_key(client, editor, ws_caller, name, tmp_path, monkeypatch)
    sealed = await _store_key(db, name, ws_victim)
    payload = {"membershipSql": MEMBERSHIP, "level": "patient", "target": {"kind": "new-database", "dataSourceId": name}}
    if pseudonymization == "reuse":
        own = await _managed(client, editor, ws_caller, "own", seed=False)
        await _store_key(db, own, ws_caller)
        payload["pseudonymization"] = {"method": "hmac", "reuseKeyOf": own}
    elif pseudonymization is not None:
        payload["pseudonymization"] = pseudonymization

    r = await client.post(f"{API}/data-sources/{src}/derive", headers=editor, json=payload)

    assert r.status_code == 400, r.text
    row = await _key(db, name)
    assert row is not None and row.workspace_id == ws_victim and row.sealed_key == sealed


async def test_the_job_itself_never_draws_or_changes_another_workspace_s_key(db):
    from types import SimpleNamespace

    from app.models.workspace import Workspace
    from app.schemas.data_source import DeriveRequest
    from app.services import cohort_derive_service

    db.add_all([Workspace(id="wv", name={"en": "v"}), Workspace(id="wr", name={"en": "r"})])
    await db.commit()
    sealed = await _store_key(db, "victim.pseudo", "wv")
    source = SimpleNamespace(id="src", workspace_id="wr")
    body = DeriveRequest.model_validate({
        "membershipSql": MEMBERSHIP, "level": "patient",
        "target": {"kind": "new-database", "dataSourceId": "victim.pseudo"},
        "pseudonymization": {"method": "hmac"},
    })
    with pytest.raises(cohort_derive_service.DeriveError):
        await cohort_derive_service._hmac_key(db, "wr", "victim.pseudo", body)
    with pytest.raises(cohort_derive_service.DeriveError):
        await cohort_derive_service._keep_key(db, source, "victim.pseudo", body, None, 1)
    row = await _key(db, "victim.pseudo")
    assert row is not None and row.sealed_key == sealed


async def test_a_rebuild_keeps_drawing_its_own_workspace_s_key(client):
    admin = await _admin(client)
    ws = await _workspace(client, admin, "A")
    src = await _managed(client, admin, ws, "src", seed=True)
    dst = await _managed(client, admin, ws, "dst", seed=True)
    payload = {
        "membershipSql": MEMBERSHIP, "level": "patient", "pseudonymization": {"method": "hmac"},
        "target": {"kind": "schema", "dataSourceId": dst, "schemaName": "pseudo"},
    }
    assert (await _derive(client, admin, ws, src, payload))["status"] == "done"
    sql = {"sql": "SELECT person_id FROM pseudo.person ORDER BY 1"}
    first = (await client.post(f"{API}/data-sources/{dst}/query", headers=admin, json=sql)).json()["rows"]
    assert (await _derive(client, admin, ws, src, {**payload, "target": {**payload["target"], "replace": True}}))["status"] == "done"
    again = (await client.post(f"{API}/data-sources/{dst}/query", headers=admin, json=sql)).json()["rows"]
    assert first == again and len(first) == 5


# --- Removing a database forgets its own keys only ----------------------------


async def test_removing_a_database_forgets_only_its_own_keys(client, db):
    admin = await _admin(client)
    ws_victim, ws_caller = await _workspace(client, admin, "V"), await _workspace(client, admin, "A")
    owner = await _member(client, db, "owner", {ws_caller: "owner"})
    victims = ["a1b2c3d4-0000-4000-8000-000000000001.pseudo", "A1B2C3D4-0000-4000-8000-000000000001.pseudo",
               "b1b2c3d4-0000-4000-8000-000000000001.pseudo"]
    for name in victims:
        await _store_key(db, name, ws_victim)
    wildcard = "a_______-____-____-____-____________"
    r = await client.post(f"{API}/data-sources", headers=owner, json={
        "id": wildcard, "workspaceId": ws_caller, "alias": "w", "name": {"en": "w"}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })
    assert r.status_code == 201, r.text
    assert (await client.delete(f"{API}/data-sources/{wildcard}", headers=owner)).status_code == 204
    for name in victims:
        assert await _key(db, name) is not None, name


async def test_removing_a_database_named_like_another_workspace_s_key_leaves_that_key(client, db):
    admin = await _admin(client)
    ws_victim, ws_caller = await _workspace(client, admin, "V"), await _workspace(client, admin, "A")
    owner = await _member(client, db, "owner", {ws_caller: "owner"})
    name = "c1b2c3d4-0000-4000-8000-000000000003.pseudo"
    r = await client.post(f"{API}/data-sources", headers=owner, json={
        "id": name, "workspaceId": ws_caller, "alias": "w", "name": {"en": "w"}, "sourceType": "database",
        "connectionConfig": {},
    })
    assert r.status_code == 201, r.text
    await _store_key(db, name, ws_victim)
    assert (await client.delete(f"{API}/data-sources/{name}", headers=owner)).status_code == 204
    assert await _key(db, name) is not None


async def test_a_new_database_cannot_take_the_name_of_a_kept_key(client, db):
    admin = await _admin(client)
    ws_victim, ws_caller = await _workspace(client, admin, "V"), await _workspace(client, admin, "A")
    owner = await _member(client, db, "owner", {ws_caller: "owner"})
    await _store_key(db, "c1b2c3d4-0000-4000-8000-000000000003.pseudo", ws_victim)
    for chosen in ("c1b2c3d4-0000-4000-8000-000000000003.pseudo", "c1b2c3d4-0000-4000-8000-000000000003"):
        r = await client.post(f"{API}/data-sources", headers=owner, json={
            "id": chosen, "workspaceId": ws_caller, "alias": "w", "name": {"en": "w"}, "sourceType": "database",
            "connectionConfig": {},
        })
        assert r.status_code == 409, (chosen, r.text)


async def test_removing_a_database_forgets_the_keys_of_its_own_derivations(client, db):
    admin = await _admin(client)
    ws = await _workspace(client, admin, "A")
    src = await _managed(client, admin, ws, "src", seed=True)
    dst = await _managed(client, admin, ws, "dst", seed=True)
    base = {"membershipSql": MEMBERSHIP, "level": "patient", "pseudonymization": {"method": "hmac"}}
    assert (await _derive(client, admin, ws, src, {
        **base, "target": {"kind": "schema", "dataSourceId": dst, "schemaName": "pseudo"},
    }))["status"] == "done"
    assert await _key(db, f"{dst}.pseudo") is not None
    assert (await client.delete(f"{API}/data-sources/{dst}", headers=admin)).status_code == 204
    assert await _key(db, f"{dst}.pseudo") is None
