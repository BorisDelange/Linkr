"""Vocabulary zips extracted beside the libraries stay within one bound, all of them
together, and leave room on the data volume."""

import shutil
import tempfile
import zipfile
from pathlib import Path

import pytest

from app.config import settings
from app.services import blob_store
from app.services import vocabulary_library as lib

API = "/api/v1"
_MB = 1024 * 1024


def _zip(name: str, size: int, method: int = zipfile.ZIP_DEFLATED) -> tuple[str, str]:
    path = Path(tempfile.mkdtemp()) / name
    with zipfile.ZipFile(path, "w", method) as zf:
        zf.writestr("CONCEPT_RELATIONSHIP.csv", b"concept_id_1\n" + b"1\n" * (size // 2))
    return (name, str(path))


def _extractions() -> list[Path]:
    root = settings.data_path / "vocabularies" / ".zips"
    return [d for d in root.iterdir() if d.is_dir()] if root.is_dir() else []


def _free_space(monkeypatch, free: int) -> None:
    monkeypatch.setattr(shutil, "disk_usage", lambda _p: shutil._ntuple_diskusage(10**12, 10**12 - free, free))


def test_zips_that_together_exceed_the_bound_are_refused_before_anything_is_written(monkeypatch):
    monkeypatch.setattr(settings, "max_vocabulary_extraction_mb", 1)
    files = [_zip("a.zip", 700 * 1024), _zip("b.zip", 700 * 1024)]
    with pytest.raises(ValueError):
        lib.expand_zips(files)
    assert _extractions() == []
    assert len(lib.expand_zips(files[:1])) == 1


def test_extractions_already_kept_count_against_the_bound(monkeypatch):
    monkeypatch.setattr(settings, "max_vocabulary_extraction_mb", 1)
    first, second = _zip("a.zip", 700 * 1024), _zip("b.zip", 700 * 1024)
    lib.expand_zips([first])
    with pytest.raises(ValueError):
        lib.expand_zips([second])
    assert len(_extractions()) == 1
    assert len(lib.expand_zips([first])) == 1
    lib.discard_zip_expansions([first])
    assert len(lib.expand_zips([second])) == 1


def test_an_extraction_leaves_the_upload_reserve_free(monkeypatch):
    monkeypatch.setattr(settings, "upload_free_space_reserve_mb", 10)
    files = [_zip("a.zip", 700 * 1024)]
    _free_space(monkeypatch, 10 * _MB)
    with pytest.raises(ValueError, match="disk space"):
        lib.expand_zips(files)
    assert _extractions() == []
    _free_space(monkeypatch, 20 * _MB)
    assert len(lib.expand_zips(files)) == 1


def test_extractions_always_leave_a_tenth_of_what_they_hold_free(monkeypatch):
    first, second = _zip("a.zip", 2 * _MB), _zip("b.zip", 2 * _MB)
    lib.expand_zips([first])
    # Room for the second zip and its own margin, not for a tenth of both.
    _free_space(monkeypatch, int(2 * _MB * 1.15))
    with pytest.raises(ValueError, match="disk space"):
        lib.expand_zips([second])
    assert len(_extractions()) == 1


def test_a_zip_whose_members_cannot_be_bounded_is_not_extracted(monkeypatch):
    files = [_zip("a.zip", 1024, zipfile.ZIP_BZIP2)]
    monkeypatch.setattr(zipfile.ZipFile, "open", lambda *a, **k: pytest.fail("inflated"))
    with pytest.raises(ValueError):
        lib.expand_zips(files)
    assert _extractions() == []


async def _admin_headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_a_failed_inspect_keeps_no_extraction(client, seed_roles):
    h = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "WS"}})).json()["id"]
    name, path = _zip("no-concept.zip", 4096)
    sha, _ = await blob_store.store_bytes(Path(path).read_bytes())
    r = await client.post(
        f"{API}/workspaces/{ws}/vocabulary-library/inspect", headers=h, json={"files": [{"fileName": name, "sha": sha}]},
    )
    assert r.status_code == 400
    assert _extractions() == []
