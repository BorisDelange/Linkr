"""Project-scoping of assigned source-concept ids for the per-project export.

The registry is workspace-wide (keyed by badge); a per-project export must keep
only the entries whose (vocab, code) belongs to THIS project — its mappings plus
its source dictionary — not every project sharing the badge. See
app/services/source_concept_id_scope.py and docs/planning/server-export-plan.md §6.
"""

from app.models.mapping_project import MappingProject
from app.services import blob_store
from app.services.source_concept_id_scope import scoped_source_concept_ids

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _workspace(client, headers) -> str:
    r = await client.post(
        f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}}
    )
    return r.json()["id"]


async def test_entries_scoped_to_project_pairs(client, db):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)

    # File project on badge "Rennes": dictionary has LOINC/1234-5 and LOINC/6789-0.
    p = (
        await client.post(
            f"{API}/mapping-projects",
            headers=headers,
            json={
                "id": "mps",
                "workspaceId": ws,
                "name": {"en": "Adult ICU"},
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
    csv = b"code,vocab\n1234-5,LOINC\n6789-0,LOINC\n"
    sha, _ = await blob_store.store_bytes(csv)
    await client.post(
        f"{API}/mapping-projects/{p['id']}/raw-file",
        headers=headers,
        json={"sha": sha, "fileName": "src.csv"},
    )

    await client.put(
        f"{API}/source-concept-id-ranges",
        headers=headers,
        json={
            "workspaceId": ws,
            "badgeLabel": "Rennes",
            "rangeStart": 2000000000,
            "rangeEnd": 2000999999,
            "nextId": 2000000003,
        },
    )
    # Three registry entries on the badge: two belong to THIS project's dictionary,
    # one (SNOMED/999) belongs to ANOTHER project sharing the badge.
    await client.put(
        f"{API}/source-concept-id-entries/batch",
        headers=headers,
        json={
            "entries": [
                {
                    "id": f"{ws}__Rennes__LOINC__1234-5",
                    "workspaceId": ws,
                    "badgeLabel": "Rennes",
                    "vocabularyId": "LOINC",
                    "conceptCode": "1234-5",
                    "sourceConceptId": 2000000000,
                },
                {
                    "id": f"{ws}__Rennes__LOINC__6789-0",
                    "workspaceId": ws,
                    "badgeLabel": "Rennes",
                    "vocabularyId": "LOINC",
                    "conceptCode": "6789-0",
                    "sourceConceptId": 2000000001,
                },
                {
                    "id": f"{ws}__Rennes__SNOMED__999",
                    "workspaceId": ws,
                    "badgeLabel": "Rennes",
                    "vocabularyId": "SNOMED",
                    "conceptCode": "999",
                    "sourceConceptId": 2000000002,
                },
            ]
        },
    )

    project = await db.get(MappingProject, "mps")
    ranges, entries, _all = await scoped_source_concept_ids(db, project)

    # Whole-badge range kept; entries scoped to the project's dictionary pairs.
    assert [r.badge_label for r in ranges] == ["Rennes"]
    kept = {(e.vocabulary_id, e.concept_code) for e in entries}
    assert kept == {("LOINC", "1234-5"), ("LOINC", "6789-0")}
    # The other project's entry (SNOMED/999) is dropped.
    assert ("SNOMED", "999") not in kept


async def test_large_dictionary_not_truncated(client, db):
    """Regression: the dictionary scope must read the WHOLE source file, not the
    default MAX_QUERY_ROWS (10k) preview cap. A truncated, non-deterministic
    subset made the exported entries.json differ on every run — it never showed
    as clean after a push. Here a >10k-row dictionary must keep all its ids."""
    from app.services.data import db_connect

    n = db_connect.MAX_QUERY_ROWS + 500  # comfortably over the preview cap
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)

    (
        await client.post(
            f"{API}/mapping-projects",
            headers=headers,
            json={
                "id": "mpl",
                "workspaceId": ws,
                "name": {"en": "Big dict"},
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
    lines = "\n".join(f"C{i},LOINC" for i in range(n))
    csv = f"code,vocab\n{lines}\n".encode()
    sha, _ = await blob_store.store_bytes(csv)
    await client.post(
        f"{API}/mapping-projects/mpl/raw-file",
        headers=headers,
        json={"sha": sha, "fileName": "src.csv"},
    )
    await client.put(
        f"{API}/source-concept-id-ranges",
        headers=headers,
        json={
            "workspaceId": ws,
            "badgeLabel": "Rennes",
            "rangeStart": 2000000000,
            "rangeEnd": 2099999999,
            "nextId": 2000000000 + n,
        },
    )
    await client.put(
        f"{API}/source-concept-id-entries/batch",
        headers=headers,
        json={
            "entries": [
                {
                    "id": f"{ws}__Rennes__LOINC__C{i}",
                    "workspaceId": ws,
                    "badgeLabel": "Rennes",
                    "vocabularyId": "LOINC",
                    "conceptCode": f"C{i}",
                    "sourceConceptId": 2000000000 + i,
                }
                for i in range(n)
            ]
        },
    )

    project = await db.get(MappingProject, "mpl")
    _, entries, _all = await scoped_source_concept_ids(db, project)
    # Every dictionary concept is in scope — none dropped by the row cap.
    assert len(entries) == n


async def test_no_badges_yields_nothing(client, db):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    (
        await client.post(
            f"{API}/mapping-projects",
            headers=headers,
            json={
                "id": "mpn",
                "workspaceId": ws,
                "name": {"en": "No badge"},
                "description": {},
                "sourceType": "file",
                "conceptSetIds": [],
            },
        )
    ).json()
    project = await db.get(MappingProject, "mpn")
    ranges, entries, _all = await scoped_source_concept_ids(db, project)
    assert ranges == [] and entries == []


async def test_mapping_pairs_included_even_without_dictionary(client, db):
    """A concept present only in the mappings (not the source file) is still in
    scope — the project 'carries' it."""
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = (
        await client.post(
            f"{API}/mapping-projects",
            headers=headers,
            json={
                "id": "mpm",
                "workspaceId": ws,
                "name": {"en": "M"},
                "description": {},
                "sourceType": "database",
                "conceptSetIds": [],
                "badges": [{"id": "b1", "label": {"en": "Rennes"}}],
            },
        )
    ).json()
    await client.post(
        f"{API}/concept-mappings/batch",
        headers=headers,
        json={
            "mappings": [
                {
                    "id": "m1",
                    "projectId": p["id"],
                    "sourceVocabularyId": "LOINC",
                    "sourceConceptCode": "1234-5",
                    "targetConceptId": 3000905,
                },
            ]
        },
    )
    await client.put(
        f"{API}/source-concept-id-ranges",
        headers=headers,
        json={
            "workspaceId": ws,
            "badgeLabel": "Rennes",
            "rangeStart": 2000000000,
            "rangeEnd": 2000999999,
            "nextId": 2000000001,
        },
    )
    await client.put(
        f"{API}/source-concept-id-entries/batch",
        headers=headers,
        json={
            "entries": [
                {
                    "id": f"{ws}__Rennes__LOINC__1234-5",
                    "workspaceId": ws,
                    "badgeLabel": "Rennes",
                    "vocabularyId": "LOINC",
                    "conceptCode": "1234-5",
                    "sourceConceptId": 2000000000,
                },
            ]
        },
    )

    project = await db.get(MappingProject, "mpm")
    _, entries, _all = await scoped_source_concept_ids(db, project)
    assert {(e.vocabulary_id, e.concept_code) for e in entries} == {("LOINC", "1234-5")}
