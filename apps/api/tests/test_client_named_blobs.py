"""A blob named by its hash is processed only for the user who put it in the store."""

import pytest

from app.services import blob_store

API = "/api/v1"
pytestmark = pytest.mark.blob_ownership

_SCORES = b"source_vocabulary_id,source_concept_code,concept_id,score\nV1,SOMEONE-ELSES-CODE,42,0.9\n"
_CONCEPT = (
    b"concept_id\tconcept_name\tdomain_id\tvocabulary_id\tconcept_class_id\tstandard_concept\tconcept_code\t"
    b"valid_start_date\tvalid_end_date\tinvalid_reason\n"
    b"1\tSOMEONE-ELSES-NAME\tMeasurement\tPRIVATEVOC\tClass\tS\tC1\t19700101\t20991231\t\n"
)


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    token = (await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"}
    )).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def _upload(client, h: dict, name: str, data: bytes) -> str:
    upload = (await client.post(f"{API}/uploads", headers=h, json={"fileName": name, "totalChunks": 1})).json()
    uid = upload["uploadId"]
    assert (await client.put(f"{API}/uploads/{uid}/chunk", headers=h, params={"index": 0}, content=data)).status_code == 204
    return (await client.post(f"{API}/uploads/{uid}/complete", headers=h)).json()["sha"]


async def _workspace(client, h: dict) -> str:
    return (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "W"}})).json()["id"]


async def _mapping_project(client, h: dict) -> str:
    ws = await _workspace(client, h)
    assert (await client.post(
        f"{API}/mapping-projects", headers=h, json={"id": "mp1", "workspaceId": ws, "name": {"en": "M"}},
    )).status_code == 201
    return f"{API}/mapping-projects/mp1"


async def test_scores_import_reads_only_a_blob_the_caller_uploaded(client, seed_roles):
    h = await _admin(client)
    base = await _mapping_project(client, h)
    foreign, _ = await blob_store.store_bytes(_SCORES)
    r = await client.post(f"{base}/scores/import-csv", headers=h, json={"files": [{"method": "m1", "sha": foreign}]})
    assert r.status_code == 400
    assert "SOMEONE-ELSES" not in r.text
    assert (await client.get(f"{base}/scores/method-csv", headers=h, params={"method": "m1"})).status_code == 404

    own = await _upload(client, h, "m1.csv", _SCORES.replace(b"SOMEONE-ELSES-CODE", b"OWN-CODE"))
    r = await client.post(f"{base}/scores/import-csv", headers=h, json={"files": [{"method": "m1", "sha": own}]})
    assert r.status_code == 200, r.text


async def test_the_vocabulary_library_reads_only_a_blob_the_caller_uploaded(client, seed_roles):
    h = await _admin(client)
    ws = await _workspace(client, h)
    base = f"{API}/workspaces/{ws}/vocabulary-library"
    foreign, _ = await blob_store.store_bytes(_CONCEPT)
    files = [{"fileName": "CONCEPT.csv", "sha": foreign}]
    r = await client.post(f"{base}/inspect", headers=h, json={"files": files})
    assert r.status_code == 400
    assert "PRIVATEVOC" not in r.text
    await client.post(f"{API}/data-sources", headers=h, json={
        "workspaceId": ws, "alias": "vocab", "name": "Vocabularies", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "vocabularyLibrary": True}, "isVocabularyReference": True,
    })
    r = await client.post(f"{base}/import", headers=h, json={"source": {"files": files}, "vocabularies": ["PRIVATEVOC"]})
    assert r.status_code == 400

    own = await _upload(client, h, "CONCEPT.csv", _CONCEPT)
    r = await client.post(f"{base}/inspect", headers=h, json={"files": [{"fileName": "CONCEPT.csv", "sha": own}]})
    assert r.status_code == 200, r.text
    assert [v["vocabularyId"] for v in r.json()["vocabularies"]] == ["PRIVATEVOC"]


async def test_an_uploaded_model_takes_only_blobs_the_caller_uploaded(client, seed_roles):
    h = await _admin(client)
    ws = await _workspace(client, h)
    foreign, _ = await blob_store.store_bytes(b'{"someone": "else"}')
    r = await client.post(f"{API}/workspaces/{ws}/suggestion-engines/models", headers=h, json={
        "source": "upload", "files": [{"fileName": "m/config.json", "sha": foreign}],
    })
    assert r.status_code == 400
    assert "Uploaded file not found" in r.text
