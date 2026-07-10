from app.core.security import hash_password
from app.models.user import User
from app.services import blob_store

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


async def _project(client, headers, ws: str, pid="mp1", source_type="database") -> dict:
    return (await client.post(f"{API}/mapping-projects", headers=headers, json={
        "id": pid, "workspaceId": ws, "name": {"en": "Mapping"}, "description": {},
        "sourceType": source_type, "dataSourceId": "src-1", "conceptSetIds": [],
    })).json()


async def test_project_crud(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _project(client, headers, ws)
    assert p["workspaceId"] == ws and p["sourceType"] == "database"

    listed = (await client.get(f"{API}/mapping-projects?workspaceId={ws}", headers=headers)).json()
    assert [x["id"] for x in listed] == [p["id"]]

    r = await client.patch(f"{API}/mapping-projects/{p['id']}", headers=headers,
                           json={"status": "in_progress", "conceptSetIds": ["cs1"]})
    assert r.json()["status"] == "in_progress" and r.json()["conceptSetIds"] == ["cs1"]

    assert (await client.delete(f"{API}/mapping-projects/{p['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/mapping-projects/{p['id']}", headers=headers)).status_code == 404


async def test_list_all_without_workspace_filter(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await _project(client, headers, ws)
    resp = await client.get(f"{API}/mapping-projects", headers=headers)
    assert resp.status_code == 200 and len(resp.json()) == 1


async def test_mapping_batch_and_cascade(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _project(client, headers, ws)

    mappings = [
        {"id": f"m{i}", "projectId": p["id"], "sourceConceptId": 2_000_000_000 + i,
         "sourceConceptCode": f"C{i}", "sourceVocabularyId": "LOINC",
         "targetConceptId": 3000 + i, "targetConceptName": f"T{i}",
         "equivalence": "equivalent", "status": "mapped"}
        for i in range(3)
    ]
    assert (await client.post(f"{API}/concept-mappings/batch", headers=headers,
                              json={"mappings": mappings})).status_code == 204

    listed = (await client.get(f"{API}/mapping-projects/{p['id']}/mappings", headers=headers)).json()
    assert {m["id"] for m in listed} == {"m0", "m1", "m2"}
    assert listed[0]["sourceConceptId"] >= 2_000_000_000

    r = await client.patch(f"{API}/concept-mappings/m0", headers=headers,
                           json={"status": "validated", "reviews": [{"reviewerId": "u1", "status": "approved"}]})
    assert r.json()["status"] == "validated" and len(r.json()["reviews"]) == 1

    # Deleting the project cascades to its mappings.
    assert (await client.delete(f"{API}/mapping-projects/{p['id']}", headers=headers)).status_code == 204
    p2 = await _project(client, headers, ws, pid="mp2")
    assert (await client.get(f"{API}/mapping-projects/{p2['id']}/mappings", headers=headers)).json() == []


async def test_raw_file_blob_round_trip(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _project(client, headers, ws, pid="mp1", source_type="file")

    # Stage a blob directly (the front uploads via /uploads; here we seed the store).
    csv = b"code,name\n1234-5,Glucose\n"
    sha, _ = await blob_store.store_bytes(csv)

    r = await client.post(f"{API}/mapping-projects/{p['id']}/raw-file", headers=headers,
                          json={"sha": sha, "fileName": "source.csv"})
    assert r.json()["rawFileSha"] == sha and r.json()["rawFileName"] == "source.csv"

    blob = await client.get(f"{API}/mapping-projects/{p['id']}/raw-file", headers=headers)
    assert blob.status_code == 200 and blob.content == csv
    assert blob.headers["x-file-name"] == "source.csv"


async def test_file_source_query(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    # File-source project with a columnMapping matching the CSV headers.
    p = (await client.post(f"{API}/mapping-projects", headers=headers, json={
        "id": "mpf", "workspaceId": ws, "name": {"en": "F"}, "description": {},
        "sourceType": "file", "conceptSetIds": [],
        "fileSourceData": {
            "fileName": "src.csv", "columns": ["code", "label", "vocab"], "rows": [],
            "columnMapping": {
                "conceptCodeColumn": "code",
                "conceptNameColumn": "label",
                "terminologyColumn": "vocab",
            },
        },
    })).json()

    csv = b"code,label,vocab\n1234-5,Glucose,LOINC\n6789-0,Sodium,LOINC\n"
    sha, _ = await blob_store.store_bytes(csv)
    await client.post(f"{API}/mapping-projects/{p['id']}/raw-file", headers=headers,
                      json={"sha": sha, "fileName": "src.csv"})

    # The frontend issues SQL against the normalized `source_concepts` view.
    r = await client.post(f"{API}/mapping-projects/{p['id']}/query", headers=headers, json={
        "sql": "SELECT concept_code, concept_name, vocabulary_id FROM source_concepts ORDER BY concept_code",
    })
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 2
    assert rows[0]["concept_code"] == "1234-5" and rows[0]["concept_name"] == "Glucose"
    assert rows[0]["vocabulary_id"] == "LOINC"


async def test_file_source_query_nullstr_na(client):
    # Parity with the browser's DuckDB-WASM mount: a literal "NA" cell reads as
    # NULL server-side too (query_file_source passes nullstr='NA').
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = (await client.post(f"{API}/mapping-projects", headers=headers, json={
        "id": "mpna", "workspaceId": ws, "name": {"en": "NA"}, "description": {},
        "sourceType": "file", "conceptSetIds": [],
        "fileSourceData": {
            "fileName": "src.csv", "columns": ["code", "vocab"], "rows": [],
            "columnMapping": {"conceptCodeColumn": "code", "terminologyColumn": "vocab"},
        },
    })).json()
    csv = b"code,vocab\nNA,LOINC\n1234-5,LOINC\n"
    sha, _ = await blob_store.store_bytes(csv)
    await client.post(f"{API}/mapping-projects/{p['id']}/raw-file", headers=headers,
                      json={"sha": sha, "fileName": "src.csv"})
    r = await client.post(f"{API}/mapping-projects/{p['id']}/query", headers=headers, json={
        "sql": "SELECT COUNT(*) AS n FROM source_concepts WHERE concept_code IS NULL",
    })
    assert r.status_code == 200 and r.json()[0]["n"] == 1


async def test_file_source_query_xlsx_sheet(client):
    # Native Excel read server-side, honoring the chosen sheet from parseOptions.
    import io
    try:
        from openpyxl import Workbook
    except ImportError:
        import pytest
        pytest.skip("openpyxl not installed")

    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = (await client.post(f"{API}/mapping-projects", headers=headers, json={
        "id": "mpx", "workspaceId": ws, "name": {"en": "X"}, "description": {},
        "sourceType": "file", "conceptSetIds": [],
        "fileSourceData": {
            "fileName": "src.xlsx", "columns": ["code", "vocab"], "rows": [],
            "columnMapping": {"conceptCodeColumn": "code", "terminologyColumn": "vocab"},
            "parseOptions": {"sheet": "Beta"},
        },
    })).json()

    wb = Workbook()
    alpha = wb.active
    alpha.title = "Alpha"
    alpha.append(["code", "vocab"])
    alpha.append(["A1", "LOINC"])
    beta = wb.create_sheet("Beta")
    beta.append(["code", "vocab"])
    beta.append(["B1", "SNOMED"])
    buf = io.BytesIO()
    wb.save(buf)
    sha, _ = await blob_store.store_bytes(buf.getvalue())
    await client.post(f"{API}/mapping-projects/{p['id']}/raw-file", headers=headers,
                      json={"sha": sha, "fileName": "src.xlsx"})

    r = await client.post(f"{API}/mapping-projects/{p['id']}/query", headers=headers, json={
        "sql": "SELECT concept_code, vocabulary_id FROM source_concepts",
    })
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1 and rows[0]["concept_code"] == "B1"
    assert rows[0]["vocabulary_id"] == "SNOMED"


async def test_service_mapping_crud(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    sm = (await client.post(f"{API}/service-mappings", headers=headers, json={
        "id": "sm1", "workspaceId": ws, "name": "ICU", "description": "",
        "rules": [{"rawValues": ["REA1", "REA2"], "groupLabel": "Réanimation"}],
    })).json()
    assert sm["rules"][0]["groupLabel"] == "Réanimation"

    listed = (await client.get(f"{API}/service-mappings?workspaceId={ws}", headers=headers)).json()
    assert [x["id"] for x in listed] == ["sm1"]

    assert (await client.delete(f"{API}/service-mappings/sm1", headers=headers)).status_code == 204


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    p = await _project(client, admin, ws)
    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/mapping-projects?workspaceId={ws}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/mapping-projects/{p['id']}/mappings", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/mapping-projects/{p['id']}", headers=other)).status_code == 403
