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
        await client.post(
            f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}}
        )
    ).json()["id"]


async def _project(client, headers, ws: str, pid="mp1", source_type="database") -> dict:
    return (
        await client.post(
            f"{API}/mapping-projects",
            headers=headers,
            json={
                "id": pid,
                "workspaceId": ws,
                "name": {"en": "Mapping"},
                "description": {},
                "sourceType": source_type,
                "dataSourceId": "src-1",
                "conceptSetIds": [],
            },
        )
    ).json()


async def test_creator_stamped_and_reattributed(client):
    # Creation stamps the authenticated user as the author; a PATCH can
    # re-attribute author + organization (Edit dialog), and both persist.
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _project(client, headers, ws)
    me = (await client.get(f"{API}/auth/me", headers=headers)).json()
    assert p["createdById"] == me["id"] and p["createdBy"]

    r = await client.patch(
        f"{API}/mapping-projects/{p['id']}",
        headers=headers,
        json={
            "createdBy": "Origin Author",
            "createdByDetails": {"orcid": "0000-0004-4444-5555"},
            "organization": {
                "id": "org-3",
                "name": {"en": "Origin Org", "fr": "Org d'origine"},
            },
        },
    )
    assert r.status_code == 200
    got = r.json()
    assert got["createdBy"] == "Origin Author"
    assert got["organization"]["name"]["fr"] == "Org d'origine"


async def test_project_crud(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _project(client, headers, ws)
    assert p["workspaceId"] == ws and p["sourceType"] == "database"

    listed = (
        await client.get(f"{API}/mapping-projects?workspaceId={ws}", headers=headers)
    ).json()
    assert [x["id"] for x in listed] == [p["id"]]

    r = await client.patch(
        f"{API}/mapping-projects/{p['id']}",
        headers=headers,
        json={"status": "in_progress", "conceptSetIds": ["cs1"]},
    )
    assert r.json()["status"] == "in_progress" and r.json()["conceptSetIds"] == ["cs1"]

    assert (
        await client.delete(f"{API}/mapping-projects/{p['id']}", headers=headers)
    ).status_code == 204
    assert (
        await client.get(f"{API}/mapping-projects/{p['id']}", headers=headers)
    ).status_code == 404


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
        {
            "id": f"m{i}",
            "projectId": p["id"],
            "sourceConceptId": 2_000_000_000 + i,
            "sourceConceptCode": f"C{i}",
            "sourceVocabularyId": "LOINC",
            "targetConceptId": 3000 + i,
            "targetConceptName": f"T{i}",
            "equivalence": "equivalent",
            "status": "mapped",
        }
        for i in range(3)
    ]
    assert (
        await client.post(
            f"{API}/concept-mappings/batch",
            headers=headers,
            json={"mappings": mappings},
        )
    ).status_code == 204

    listed = (
        await client.get(f"{API}/mapping-projects/{p['id']}/mappings", headers=headers)
    ).json()
    assert {m["id"] for m in listed} == {"m0", "m1", "m2"}
    assert listed[0]["sourceConceptId"] >= 2_000_000_000

    r = await client.patch(
        f"{API}/concept-mappings/m0",
        headers=headers,
        json={
            "status": "validated",
            "reviews": [{"reviewerId": "u1", "status": "approved"}],
        },
    )
    assert r.json()["status"] == "validated" and len(r.json()["reviews"]) == 1

    # Deleting the project cascades to its mappings.
    assert (
        await client.delete(f"{API}/mapping-projects/{p['id']}", headers=headers)
    ).status_code == 204
    p2 = await _project(client, headers, ws, pid="mp2")
    assert (
        await client.get(f"{API}/mapping-projects/{p2['id']}/mappings", headers=headers)
    ).json() == []


async def test_raw_file_blob_round_trip(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _project(client, headers, ws, pid="mp1", source_type="file")

    # Stage a blob directly (the front uploads via /uploads; here we seed the store).
    csv = b"code,name\n1234-5,Glucose\n"
    sha, _ = await blob_store.store_bytes(csv)

    r = await client.post(
        f"{API}/mapping-projects/{p['id']}/raw-file",
        headers=headers,
        json={"sha": sha, "fileName": "source.csv"},
    )
    assert r.json()["rawFileSha"] == sha and r.json()["rawFileName"] == "source.csv"

    blob = await client.get(
        f"{API}/mapping-projects/{p['id']}/raw-file", headers=headers
    )
    assert blob.status_code == 200 and blob.content == csv
    assert blob.headers["x-file-name"] == "source.csv"


async def test_file_source_query(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    # File-source project with a columnMapping matching the CSV headers.
    p = (
        await client.post(
            f"{API}/mapping-projects",
            headers=headers,
            json={
                "id": "mpf",
                "workspaceId": ws,
                "name": {"en": "F"},
                "description": {},
                "sourceType": "file",
                "conceptSetIds": [],
                "fileSourceData": {
                    "fileName": "src.csv",
                    "columns": ["code", "label", "vocab"],
                    "rows": [],
                    "columnMapping": {
                        "conceptCodeColumn": "code",
                        "conceptNameColumn": "label",
                        "terminologyColumn": "vocab",
                    },
                },
            },
        )
    ).json()

    csv = b"code,label,vocab\n1234-5,Glucose,LOINC\n6789-0,Sodium,LOINC\n"
    sha, _ = await blob_store.store_bytes(csv)
    await client.post(
        f"{API}/mapping-projects/{p['id']}/raw-file",
        headers=headers,
        json={"sha": sha, "fileName": "src.csv"},
    )

    # The frontend issues SQL against the normalized `source_concepts` view.
    r = await client.post(
        f"{API}/mapping-projects/{p['id']}/query",
        headers=headers,
        json={
            "sql": "SELECT concept_code, concept_name, vocabulary_id FROM source_concepts ORDER BY concept_code",
        },
    )
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 2
    assert rows[0]["concept_code"] == "1234-5" and rows[0]["concept_name"] == "Glucose"
    assert rows[0]["vocabulary_id"] == "LOINC"


async def test_source_concept_id_counts(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    # A range [2_000_000, 2_000_099] for badge ICU.
    await client.put(
        f"{API}/source-concept-id-ranges",
        headers=headers,
        json={
            "workspaceId": ws,
            "badgeLabel": "ICU",
            "rangeStart": 2000000,
            "rangeEnd": 2000099,
            "nextId": 2000002,
        },
    )
    # Two entries in-range, one out-of-range (inherited from another badge).
    await client.put(
        f"{API}/source-concept-id-entries/batch",
        headers=headers,
        json={
            "entries": [
                {
                    "id": f"{ws}__ICU__LOINC__a",
                    "workspaceId": ws,
                    "badgeLabel": "ICU",
                    "vocabularyId": "LOINC",
                    "conceptCode": "a",
                    "sourceConceptId": 2000000,
                },
                {
                    "id": f"{ws}__ICU__LOINC__b",
                    "workspaceId": ws,
                    "badgeLabel": "ICU",
                    "vocabularyId": "LOINC",
                    "conceptCode": "b",
                    "sourceConceptId": 2000001,
                },
                {
                    "id": f"{ws}__ICU__LOINC__c",
                    "workspaceId": ws,
                    "badgeLabel": "ICU",
                    "vocabularyId": "LOINC",
                    "conceptCode": "c",
                    "sourceConceptId": 9999999,
                },
            ]
        },
    )

    r = await client.get(
        f"{API}/source-concept-id-entries/counts?workspaceId={ws}", headers=headers
    )
    assert r.status_code == 200
    counts = {c["badgeLabel"]: c for c in r.json()}
    assert counts["ICU"]["assignedCount"] == 3
    assert counts["ICU"]["ownCount"] == 2  # only the two within the range


async def test_global_table_flat_and_dedup(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    # File project, no conceptIdColumn → artificial ids resolved via the registry.
    p = (
        await client.post(
            f"{API}/mapping-projects",
            headers=headers,
            json={
                "id": "mpg",
                "workspaceId": ws,
                "name": {"en": "G"},
                "description": {},
                "sourceType": "file",
                "conceptSetIds": [],
                "badges": [{"id": "b1", "label": "ICU"}],
                "fileSourceData": {
                    "fileName": "src.csv",
                    "columns": ["code", "label", "vocab"],
                    "rows": [],
                    "columnMapping": {
                        "conceptCodeColumn": "code",
                        "conceptNameColumn": "label",
                        "terminologyColumn": "vocab",
                    },
                },
            },
        )
    ).json()
    csv = b"code,label,vocab\n1234-5,Glucose,LOINC\n6789-0,Sodium,LOINC\n"
    sha, _ = await blob_store.store_bytes(csv)
    await client.post(
        f"{API}/mapping-projects/{p['id']}/raw-file",
        headers=headers,
        json={"sha": sha, "fileName": "src.csv"},
    )

    # One mapping (Glucose) + one registry id for it.
    await client.post(
        f"{API}/concept-mappings",
        headers=headers,
        json={
            "id": "gm1",
            "projectId": p["id"],
            "sourceVocabularyId": "LOINC",
            "sourceConceptCode": "1234-5",
            "sourceConceptName": "Glucose",
            "targetConceptId": 3000905,
            "targetConceptName": "Glucose [Mass/volume]",
            "targetVocabularyId": "LOINC",
            "status": "approved",
        },
    )
    await client.put(
        f"{API}/source-concept-id-entries",
        headers=headers,
        json={
            "id": f"{ws}__ICU__LOINC__1234-5",
            "workspaceId": ws,
            "badgeLabel": "ICU",
            "vocabularyId": "LOINC",
            "conceptCode": "1234-5",
            "sourceConceptId": 2000001,
        },
    )

    # Build the flat cache: returns a signature, total, and distinct filter
    # values (source vocabulary must be present — it feeds the UI dropdown).
    rb = await client.post(
        f"{API}/mapping-projects/global-table/build",
        headers=headers,
        json={
            "workspaceId": ws,
            "mode": "flat",
        },
    )
    assert rb.status_code == 200, rb.text
    build = rb.json()
    sig = build["signature"]
    assert build["total"] == 2
    assert build["filterValues"]["source_vocabulary_id"] == ["LOINC"]

    # Query the cache by signature — 1 mapped (Glucose) + 1 unmapped (Sodium).
    r = await client.post(
        f"{API}/mapping-projects/global-table/query",
        headers=headers,
        json={
            "workspaceId": ws,
            "mode": "flat",
            "signature": sig,
            "limit": 50,
            "offset": 0,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 2
    glucose = next(x for x in body["rows"] if x["source_concept_code"] == "1234-5")
    sodium = next(x for x in body["rows"] if x["source_concept_code"] == "6789-0")
    assert glucose["is_unmapped"] is False
    assert glucose["resolved_source_concept_id"] == 2000001  # from registry
    assert sodium["is_unmapped"] is True

    # Source-vocabulary filter narrows correctly (the filter that was missing).
    rv = await client.post(
        f"{API}/mapping-projects/global-table/query",
        headers=headers,
        json={
            "workspaceId": ws,
            "mode": "flat",
            "signature": sig,
            "filters": {"sourceVocabularyId": "LOINC"},
        },
    )
    assert rv.json()["total"] == 2

    # Search filter narrows to Sodium.
    r2 = await client.post(
        f"{API}/mapping-projects/global-table/query",
        headers=headers,
        json={
            "workspaceId": ws,
            "mode": "flat",
            "signature": sig,
            "filters": {"globalSearch": "sodium"},
        },
    )
    assert r2.json()["total"] == 1

    # A stale/unknown signature → 409 so the client rebuilds.
    r409 = await client.post(
        f"{API}/mapping-projects/global-table/query",
        headers=headers,
        json={
            "workspaceId": ws,
            "mode": "flat",
            "signature": "deadbeefdeadbeef",
        },
    )
    assert r409.status_code == 409

    # Dedup (badge) mode also returns both, one row each.
    rbd = await client.post(
        f"{API}/mapping-projects/global-table/build",
        headers=headers,
        json={
            "workspaceId": ws,
            "mode": "dedup",
        },
    )
    assert rbd.status_code == 200
    r3 = await client.post(
        f"{API}/mapping-projects/global-table/query",
        headers=headers,
        json={
            "workspaceId": ws,
            "mode": "dedup",
            "signature": rbd.json()["signature"],
        },
    )
    assert r3.status_code == 200 and r3.json()["total"] == 2


async def test_file_source_query_nullstr_na(client):
    # Parity with the browser's DuckDB-WASM mount: a literal "NA" cell reads as
    # NULL server-side too (query_file_source passes nullstr='NA').
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = (
        await client.post(
            f"{API}/mapping-projects",
            headers=headers,
            json={
                "id": "mpna",
                "workspaceId": ws,
                "name": {"en": "NA"},
                "description": {},
                "sourceType": "file",
                "conceptSetIds": [],
                "fileSourceData": {
                    "fileName": "src.csv",
                    "columns": ["code", "vocab"],
                    "rows": [],
                    "columnMapping": {
                        "conceptCodeColumn": "code",
                        "terminologyColumn": "vocab",
                    },
                },
            },
        )
    ).json()
    csv = b"code,vocab\nNA,LOINC\n1234-5,LOINC\n"
    sha, _ = await blob_store.store_bytes(csv)
    await client.post(
        f"{API}/mapping-projects/{p['id']}/raw-file",
        headers=headers,
        json={"sha": sha, "fileName": "src.csv"},
    )
    r = await client.post(
        f"{API}/mapping-projects/{p['id']}/query",
        headers=headers,
        json={
            "sql": "SELECT COUNT(*) AS n FROM source_concepts WHERE concept_code IS NULL",
        },
    )
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
    p = (
        await client.post(
            f"{API}/mapping-projects",
            headers=headers,
            json={
                "id": "mpx",
                "workspaceId": ws,
                "name": {"en": "X"},
                "description": {},
                "sourceType": "file",
                "conceptSetIds": [],
                "fileSourceData": {
                    "fileName": "src.xlsx",
                    "columns": ["code", "vocab"],
                    "rows": [],
                    "columnMapping": {
                        "conceptCodeColumn": "code",
                        "terminologyColumn": "vocab",
                    },
                    "parseOptions": {"sheet": "Beta"},
                },
            },
        )
    ).json()

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
    await client.post(
        f"{API}/mapping-projects/{p['id']}/raw-file",
        headers=headers,
        json={"sha": sha, "fileName": "src.xlsx"},
    )

    r = await client.post(
        f"{API}/mapping-projects/{p['id']}/query",
        headers=headers,
        json={
            "sql": "SELECT concept_code, vocabulary_id FROM source_concepts",
        },
    )
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1 and rows[0]["concept_code"] == "B1"
    assert rows[0]["vocabulary_id"] == "SNOMED"


async def test_project_stats_dedup_and_effective_status(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _project(client, headers, ws)

    # Two mappings on the SAME source key (LOINC:C0) → one deduped source concept.
    # One approved by a review vote (effective status wins over stored 'mapped'),
    # one flagged. A third source (C1) is stored-ignored. A fourth (C2) mapped.
    await client.post(
        f"{API}/concept-mappings/batch",
        headers=headers,
        json={
            "mappings": [
                {
                    "id": "m0",
                    "projectId": p["id"],
                    "sourceVocabularyId": "LOINC",
                    "sourceConceptCode": "C0",
                    "targetConceptId": 3000,
                    "status": "mapped",
                    "reviews": [{"status": "approved"}],
                },
                {
                    "id": "m1",
                    "projectId": p["id"],
                    "sourceVocabularyId": "LOINC",
                    "sourceConceptCode": "C0",
                    "targetConceptId": 3001,
                    "status": "flagged",
                },
                {
                    "id": "m2",
                    "projectId": p["id"],
                    "sourceVocabularyId": "LOINC",
                    "sourceConceptCode": "C1",
                    "targetConceptId": 3002,
                    "status": "ignored",
                },
                {
                    "id": "m3",
                    "projectId": p["id"],
                    "sourceVocabularyId": "LOINC",
                    "sourceConceptCode": "C2",
                    "targetConceptId": 3003,
                    "status": "mapped",
                },
            ]
        },
    )

    stats = (
        await client.get(f"{API}/mapping-projects/{p['id']}/stats", headers=headers)
    ).json()
    # Deduped keys: C0 (mapped, approved via review), C2 (mapped). C1 is ignored.
    assert stats["mappedCount"] == 2
    assert stats["approvedCount"] == 1  # only C0
    assert stats["ignoredCount"] == 1  # C1
    # totalSourceConcepts / unmappedCount come from the source table, not here.
    assert stats["totalSourceConcepts"] == 0


async def test_workspace_mapped_keys_excludes_current_project(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    a = await _project(client, headers, ws, pid="pa")
    b = await _project(client, headers, ws, pid="pb")

    await client.post(
        f"{API}/concept-mappings/batch",
        headers=headers,
        json={
            "mappings": [
                # Project A: one mapped, one ignored (excluded), one unmapped target=0 (excluded).
                {
                    "id": "a0",
                    "projectId": a["id"],
                    "sourceVocabularyId": "LOINC",
                    "sourceConceptCode": "X",
                    "targetConceptId": 10,
                    "status": "mapped",
                },
                {
                    "id": "a1",
                    "projectId": a["id"],
                    "sourceVocabularyId": "LOINC",
                    "sourceConceptCode": "Y",
                    "targetConceptId": 11,
                    "status": "ignored",
                },
                {
                    "id": "a2",
                    "projectId": a["id"],
                    "sourceVocabularyId": "LOINC",
                    "sourceConceptCode": "Z",
                    "targetConceptId": 0,
                    "status": "mapped",
                },
                # Project B: one mapped — should NOT appear when excluding B.
                {
                    "id": "b0",
                    "projectId": b["id"],
                    "sourceVocabularyId": "SNOMED",
                    "sourceConceptCode": "S",
                    "targetConceptId": 20,
                    "status": "mapped",
                },
            ]
        },
    )

    # From B's point of view, "mapped elsewhere" = A's valid keys only.
    keys = (
        await client.get(
            f"{API}/workspaces/{ws}/mapping-mapped-keys?exclude={b['id']}",
            headers=headers,
        )
    ).json()
    assert keys == ["LOINC:X"]  # Y ignored, Z target=0, S excluded (own project)


async def test_service_mapping_crud(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    sm = (
        await client.post(
            f"{API}/service-mappings",
            headers=headers,
            json={
                "id": "sm1",
                "workspaceId": ws,
                "name": "ICU",
                "description": "",
                "rules": [{"rawValues": ["REA1", "REA2"], "groupLabel": "Réanimation"}],
            },
        )
    ).json()
    assert sm["rules"][0]["groupLabel"] == "Réanimation"

    listed = (
        await client.get(f"{API}/service-mappings?workspaceId={ws}", headers=headers)
    ).json()
    assert [x["id"] for x in listed] == ["sm1"]

    assert (
        await client.delete(f"{API}/service-mappings/sm1", headers=headers)
    ).status_code == 204


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    p = await _project(client, admin, ws)
    other = await _create_user(db, client, "bob")
    assert (
        await client.get(f"{API}/mapping-projects?workspaceId={ws}", headers=other)
    ).status_code == 403
    assert (
        await client.get(f"{API}/mapping-projects/{p['id']}/mappings", headers=other)
    ).status_code == 403
    assert (
        await client.delete(f"{API}/mapping-projects/{p['id']}", headers=other)
    ).status_code == 403


async def test_query_and_preview_columns_require_editor(client, db):
    """A viewer must NOT run arbitrary SQL over a file source (/query runs
    server-side DuckDB) nor probe an arbitrary blob's columns (/preview-columns
    reads a globally-content-addressed blob). Both require editor."""
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    p = (
        await client.post(
            f"{API}/mapping-projects",
            headers=admin,
            json={
                "id": "mpv",
                "workspaceId": ws,
                "name": {"en": "F"},
                "description": {},
                "sourceType": "file",
                "conceptSetIds": [],
                "fileSourceData": {
                    "fileName": "src.csv",
                    "columns": ["code"],
                    "rows": [],
                    "columnMapping": {"conceptCodeColumn": "code"},
                },
            },
        )
    ).json()
    csv = b"code\n1234-5\n"
    sha, _ = await blob_store.store_bytes(csv)
    await client.post(
        f"{API}/mapping-projects/{p['id']}/raw-file",
        headers=admin,
        json={"sha": sha, "fileName": "src.csv"},
    )

    viewer = await _create_user(db, client, "bob")
    me = (await client.get(f"{API}/auth/me", headers=viewer)).json()
    await client.put(
        f"{API}/workspaces/{ws}/members",
        headers=admin,
        json={"userId": me["id"], "role": "viewer"},
    )

    # viewer: forbidden on both hardened endpoints
    assert (
        await client.post(
            f"{API}/mapping-projects/{p['id']}/query",
            headers=viewer,
            json={"sql": "SELECT * FROM source_concepts"},
        )
    ).status_code == 403
    assert (
        await client.post(
            f"{API}/mapping-projects/preview-columns",
            headers=viewer,
            json={"workspaceId": ws, "sha": sha, "fileName": "src.csv"},
        )
    ).status_code == 403

    # editor (the admin/owner here) still works on both
    assert (
        await client.post(
            f"{API}/mapping-projects/{p['id']}/query",
            headers=admin,
            json={"sql": "SELECT * FROM source_concepts"},
        )
    ).status_code == 200
    pv = await client.post(
        f"{API}/mapping-projects/preview-columns",
        headers=admin,
        json={"workspaceId": ws, "sha": sha, "fileName": "src.csv"},
    )
    assert pv.status_code == 200 and pv.json()["columns"] == ["code"]


async def test_export_zip_builds_server_side(client):
    """The export-zip endpoint returns a server-built ZIP with the git-variant
    tree — no client upload, the browser only downloads."""
    import io
    import zipfile

    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = (
        await client.post(
            f"{API}/mapping-projects",
            headers=headers,
            json={
                "id": "mpz",
                "workspaceId": ws,
                "name": {"en": "Export me"},
                "description": {},
                "sourceType": "file",
                "conceptSetIds": [],
                "badges": [{"id": "b1", "label": {"en": "Rennes"}}],
                "fileSourceData": {
                    "fileName": "src.csv",
                    "columns": ["code", "vocab"],
                    "rows": [],
                    "columnMapping": {
                        "conceptCodeColumn": "code",
                        "terminologyColumn": "vocab",
                    },
                },
            },
        )
    ).json()
    csv = b"code,vocab\n1234-5,LOINC\n"
    sha, _ = await blob_store.store_bytes(csv)
    await client.post(
        f"{API}/mapping-projects/{p['id']}/raw-file",
        headers=headers,
        json={"sha": sha, "fileName": "src.csv"},
    )

    r = await client.get(
        f"{API}/mapping-projects/{p['id']}/export-zip", headers=headers
    )
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert 'filename="Export me.zip"' in r.headers["content-disposition"]

    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(zf.namelist())
    assert {
        "project.json",
        "mappings.json",
        "source-concepts.csv",
        ".gitignore",
    } <= names
    # Source CSV is written verbatim.
    assert zf.read("source-concepts.csv") == csv
    assert zf.read(".gitignore") == b"*.parquet\nreview/\nstate.json\n"
