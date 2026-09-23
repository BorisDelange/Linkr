"""A database created from a schema can live in a server folder the user chose
(`connectionConfig.managedPath`) instead of Linkr's data folder. Linkr owns that
file — it writes into it and a rebuild deletes it — so the location is validated
as a NEW file, set once by create-from-ddl, and never taken from a client."""

import os

import pytest

from app.services import fs_browser

API = "/api/v1"
DDL = "CREATE TABLE person (person_id BIGINT);"


def _set_roots(monkeypatch, roots: str):
    from app.config import settings

    monkeypatch.setattr(settings, "fs_browse_roots", roots)


async def _headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _source(client, headers, config: dict | None = None) -> dict:
    ws = (
        await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})
    ).json()["id"]
    return (
        await client.post(
            f"{API}/data-sources",
            headers=headers,
            json={
                "workspaceId": ws,
                "alias": "omop",
                "name": "OMOP",
                "sourceType": "database",
                "connectionConfig": config or {"engine": "duckdb", "managed": True},
            },
        )
    ).json()


# --- check_new_database_file -------------------------------------------------


def test_accepts_a_new_file_in_a_writable_folder(tmp_path, monkeypatch):
    _set_roots(monkeypatch, str(tmp_path))
    r = fs_browser.check_new_database_file(str(tmp_path / "study.duckdb"))
    assert r == {"ok": True, "path": str((tmp_path / "study.duckdb").resolve())}


def test_refuses_an_existing_file(tmp_path, monkeypatch):
    """The file will be written into and, on rebuild, deleted."""
    _set_roots(monkeypatch, str(tmp_path))
    (tmp_path / "theirs.duckdb").write_text("x")
    assert fs_browser.check_new_database_file(str(tmp_path / "theirs.duckdb"))["reason"] == "exists"


@pytest.mark.parametrize("name", ["notes.txt", "db", ".duckdb"])
def test_refuses_anything_but_a_named_duckdb_file(tmp_path, monkeypatch, name):
    _set_roots(monkeypatch, str(tmp_path))
    assert fs_browser.check_new_database_file(str(tmp_path / name))["reason"] == "wrong_extension"


def test_refuses_outside_the_roots_and_through_a_symlink(tmp_path, monkeypatch):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    _set_roots(monkeypatch, str(root))
    assert fs_browser.check_new_database_file(str(outside / "a.duckdb"))["reason"] == "outside_roots"
    # A folder inside the root that links out must not be a way through.
    os.symlink(outside, root / "link")
    assert fs_browser.check_new_database_file(str(root / "link" / "a.duckdb"))["reason"] == "outside_roots"


def test_refuses_a_missing_folder_and_a_relative_path(tmp_path, monkeypatch):
    _set_roots(monkeypatch, str(tmp_path))
    assert fs_browser.check_new_database_file(str(tmp_path / "nope" / "a.duckdb"))["reason"] == "not_found"
    assert fs_browser.check_new_database_file("a.duckdb")["reason"] == "not_absolute"


# --- create-from-ddl ---------------------------------------------------------


async def test_creates_the_file_where_asked_and_serves_it(client, tmp_path, monkeypatch):
    _set_roots(monkeypatch, str(tmp_path))
    headers = await _headers(client)
    src = await _source(client, headers)
    target = tmp_path / "study.duckdb"

    r = await client.post(
        f"{API}/data-sources/{src['id']}/create-from-ddl",
        headers=headers,
        json={"ddl": DDL, "path": str(target)},
    )
    assert r.status_code == 200, r.text
    assert r.json()["connectionConfig"]["managedPath"] == str(target.resolve())
    assert target.is_file()

    rows = (
        await client.post(
            f"{API}/data-sources/{src['id']}/query",
            headers=headers,
            json={"sql": "SELECT count(*) AS n FROM person"},
        )
    ).json()["rows"]
    assert rows == [{"n": 0}]
    info = (await client.get(f"{API}/data-sources/{src['id']}/connection-info", headers=headers)).json()
    assert info["path"] == str(target.resolve())

    # A rebuild without a path stays where the file was created.
    r = await client.post(
        f"{API}/data-sources/{src['id']}/create-from-ddl", headers=headers, json={"ddl": DDL}
    )
    assert r.status_code == 200 and target.is_file(), r.text


async def test_refuses_an_existing_file_and_a_move(client, tmp_path, monkeypatch):
    _set_roots(monkeypatch, str(tmp_path))
    headers = await _headers(client)
    src = await _source(client, headers)
    (tmp_path / "theirs.duckdb").write_text("precious")

    r = await client.post(
        f"{API}/data-sources/{src['id']}/create-from-ddl",
        headers=headers,
        json={"ddl": DDL, "path": str(tmp_path / "theirs.duckdb")},
    )
    assert r.status_code == 400
    assert (tmp_path / "theirs.duckdb").read_text() == "precious"

    await client.post(
        f"{API}/data-sources/{src['id']}/create-from-ddl",
        headers=headers,
        json={"ddl": DDL, "path": str(tmp_path / "a.duckdb")},
    )
    r = await client.post(
        f"{API}/data-sources/{src['id']}/create-from-ddl",
        headers=headers,
        json={"ddl": DDL, "path": str(tmp_path / "b.duckdb")},
    )
    assert r.status_code == 400
    assert not (tmp_path / "b.duckdb").exists()


async def test_a_client_can_neither_set_nor_change_the_location(client, tmp_path, monkeypatch):
    """Otherwise a plain create/PATCH could aim the ETL and the rebuild at any file."""
    _set_roots(monkeypatch, str(tmp_path))
    headers = await _headers(client)
    victim = tmp_path / "victim.duckdb"
    src = await _source(
        client, headers, {"engine": "duckdb", "managed": True, "managedPath": str(victim)}
    )
    assert "managedPath" not in src["connectionConfig"]

    target = tmp_path / "mine.duckdb"
    await client.post(
        f"{API}/data-sources/{src['id']}/create-from-ddl",
        headers=headers,
        json={"ddl": DDL, "path": str(target)},
    )
    r = await client.patch(
        f"{API}/data-sources/{src['id']}",
        headers=headers,
        json={"connectionConfig": {"engine": "duckdb", "managed": True, "managedPath": str(victim)}},
    )
    assert r.status_code == 200
    assert r.json()["connectionConfig"]["managedPath"] == str(target.resolve())
    # Even a config without the key keeps it: the file does not move.
    r = await client.patch(
        f"{API}/data-sources/{src['id']}",
        headers=headers,
        json={"connectionConfig": {"engine": "duckdb", "managed": True}},
    )
    assert r.json()["connectionConfig"]["managedPath"] == str(target.resolve())


async def test_deleting_the_database_leaves_a_chosen_file_in_place(client, tmp_path, monkeypatch):
    _set_roots(monkeypatch, str(tmp_path))
    headers = await _headers(client)
    src = await _source(client, headers)
    target = tmp_path / "keep.duckdb"
    await client.post(
        f"{API}/data-sources/{src['id']}/create-from-ddl",
        headers=headers,
        json={"ddl": DDL, "path": str(target)},
    )
    r = await client.delete(f"{API}/data-sources/{src['id']}", headers=headers)
    assert r.status_code in (200, 204)
    assert target.is_file()


async def test_validate_path_answers_for_a_new_file(client, tmp_path, monkeypatch):
    _set_roots(monkeypatch, str(tmp_path))
    headers = await _headers(client)
    src = await _source(client, headers)
    ws = src["workspaceId"]
    (tmp_path / "taken.duckdb").write_text("x")

    async def check(path: str, expect: str) -> dict:
        return (
            await client.post(
                f"{API}/workspaces/{ws}/fs/validate-path",
                headers=headers,
                json={"path": path, "expect": expect},
            )
        ).json()

    assert (await check(str(tmp_path / "new.duckdb"), "new-file"))["ok"] is True
    assert (await check(str(tmp_path / "taken.duckdb"), "new-file"))["reason"] == "exists"
    assert (await check(str(tmp_path), "writable-dir"))["ok"] is True
