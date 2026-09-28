"""The workspace vocabulary library: an ATHENA export split by vocabulary, one
version of each held at a time, read back as union views."""

import asyncio
import tempfile
from pathlib import Path

import duckdb

from app.services import blob_store
from app.services import vocabulary_library as lib

API = "/api/v1"

# ATHENA writes tab-separated, unquoted files; a concept name may hold a lone `"`.
_CONCEPT = [
    "concept_id\tconcept_name\tdomain_id\tvocabulary_id\tconcept_class_id\tstandard_concept\tconcept_code\tvalid_start_date\tvalid_end_date\tinvalid_reason",
    "1\tHeart rate\tMeasurement\tLOINC\tClinical Observation\tS\t8867-4\t19700101\t20991231\t",
    "2\tPulse \"radial\tMeasurement\tSNOMED\tObservable Entity\tS\t364075005\t20020131\t20991231\t",
    "3\tVital signs\tMeasurement\tSNOMED\tObservable Entity\t\t46680005\t20020131\t20991231\t",
    "4\tMeasurement\tMeasurement\tDomain\tDomain\t\tOMOP generated\t19700101\t20991231\t",
]
_RELATIONSHIP = [
    "concept_id_1\tconcept_id_2\trelationship_id\tvalid_start_date\tvalid_end_date\tinvalid_reason",
    "1\t2\tMaps to\t19700101\t20991231\t",
    "2\t1\tMapped from\t19700101\t20991231\t",
]
_ANCESTOR = [
    "ancestor_concept_id\tdescendant_concept_id\tmin_levels_of_separation\tmax_levels_of_separation",
    "3\t2\t1\t1",
]
_VOCABULARY = [
    "vocabulary_id\tvocabulary_name\tvocabulary_reference\tvocabulary_version\tvocabulary_concept_id",
    "None\tOMOP Standardized Vocabularies\tOMOP generated\tv5.0 27-FEB-26\t44819096",
    "LOINC\tLogical Observation Identifiers Names and Codes\thttp://loinc.org\tLOINC 2.77\t44819102",
    "SNOMED\tSystematic Nomenclature of Medicine - Clinical Terms\thttp://snomed.info\t2025-02-01 SNOMED CT International Edition\t44819097",
    "Domain\tOMOP Domain\tOMOP generated\t\t44819147",
]
_DOMAIN = ["domain_id\tdomain_name\tdomain_concept_id", "Measurement\tMeasurement\t21"]


def _export(**overrides: list[str]) -> list[tuple[str, str]]:
    tables = {
        "CONCEPT": _CONCEPT, "CONCEPT_RELATIONSHIP": _RELATIONSHIP, "CONCEPT_ANCESTOR": _ANCESTOR,
        "VOCABULARY": _VOCABULARY, "DOMAIN": _DOMAIN, **overrides,
    }
    d = Path(tempfile.mkdtemp())
    out = []
    for name, lines in tables.items():
        p = d / f"{name}.csv"
        p.write_text("\n".join(lines) + "\n")
        out.append((f"athena/{name}.csv", str(p)))
    return out


def _union(workspace_id: str, table: str) -> str:
    files = [p for n, p in lib.library_files(workspace_id) if n.startswith(f"{table}/")]
    return f"read_parquet([{', '.join(repr(p) for p in files)}], union_by_name=true)"


def test_inspect_reads_versions_and_counts():
    found = lib.inspect_export(_export())
    assert found["release"] == "v5.0 27-FEB-26"
    assert [(v["vocabularyId"], v["vocabularyVersion"], v["conceptCount"]) for v in found["vocabularies"]] == [
        ("Domain", None, 1),
        ("LOINC", "LOINC 2.77", 1),
        ("SNOMED", "2025-02-01 SNOMED CT International Edition", 2),
    ]


def test_partitions_follow_the_owning_concept():
    written = lib.write_partitions("ws", _export(), ["LOINC", "SNOMED", "Domain"])
    assert {w["vocabularyId"]: w["rowCounts"] for w in written}["SNOMED"] == {
        "concept": 2, "vocabulary": 1, "concept_relationship": 1, "concept_ancestor": 1,
    }
    names = sorted(n for n, _ in lib.library_files("ws"))
    # `Domain` is a vocabulary id AND a table name: the prefix keeps them apart.
    assert "concept/vocab-Domain.parquet" in names and "domain/shared.parquet" in names
    rows = duckdb.sql(f"SELECT concept_id, concept_name, valid_start_date FROM {_union('ws', 'concept')} ORDER BY 1").fetchall()
    assert [(r[0], r[1]) for r in rows] == [(1, "Heart rate"), (2, 'Pulse "radial'), (3, "Vital signs"), (4, "Measurement")]
    assert str(rows[0][2]) == "1970-01-01"
    rel = duckdb.sql(f"SELECT concept_id_1, relationship_id FROM {_union('ws', 'concept_relationship')} ORDER BY 1").fetchall()
    assert rel == [(1, "Maps to"), (2, "Mapped from")]


def test_reimport_replaces_only_the_chosen_vocabulary():
    lib.write_partitions("ws", _export(), ["LOINC", "SNOMED"])
    newer = [line.replace("Pulse \"radial", "Pulse rate") for line in _CONCEPT]
    lib.write_partitions("ws", _export(CONCEPT=newer), ["SNOMED"])
    names = dict(duckdb.sql(f"SELECT concept_id, concept_name FROM {_union('ws', 'concept')}").fetchall())
    assert names == {1: "Heart rate", 2: "Pulse rate", 3: "Vital signs"}
    lib.remove_partitions("ws", "SNOMED")
    assert sorted(n for n, _ in lib.library_files("ws") if n.startswith("concept/")) == ["concept/vocab-LOINC.parquet"]


def test_a_parquet_export_reads_like_a_csv_one():
    d = Path(tempfile.mkdtemp())
    csv = dict((Path(n).stem, p) for n, p in _export())
    files = []
    for table, path in csv.items():
        out = d / f"{table.lower()}.parquet"
        duckdb.sql(
            f"COPY (SELECT * FROM read_csv('{path}', delim='\\t', quote='', header=true)) TO '{out}' (FORMAT PARQUET)"
        )
        files.append((out.name, str(out)))
    lib.write_partitions("ws", files, ["SNOMED"])
    assert duckdb.sql(f"SELECT COUNT(*) FROM {_union('ws', 'concept')}").fetchone()[0] == 2


async def _admin_headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_import_route_fills_the_library_data_source(client):
    headers = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    base = f"{API}/workspaces/{ws}/vocabulary-library"
    assert (await client.get(base, headers=headers)).json() == {"dataSourceId": None, "vocabularies": []}

    files = []
    for name, path in _export():
        sha, _ = await blob_store.store_bytes(Path(path).read_bytes())
        files.append({"fileName": name, "sha": sha})
    assert (await client.post(f"{base}/import", headers=headers, json={
        "source": {"files": files}, "vocabularies": ["SNOMED"]})).status_code == 409

    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "vocab", "name": "Vocabularies", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "vocabularyLibrary": True},
        "schemaMapping": {"knownTables": list(lib.LIBRARY_TABLES)},
        "isVocabularyReference": True,
    })).json()

    preview = (await client.post(f"{base}/inspect", headers=headers, json={"files": files})).json()
    assert [(v["vocabularyId"], v["inLibrary"]) for v in preview["vocabularies"]] == [
        ("Domain", False), ("LOINC", False), ("SNOMED", False),
    ]

    state = (await client.post(f"{base}/import", headers=headers, json={
        "source": {"files": files}, "vocabularies": ["SNOMED", "LOINC"]})).json()
    for _ in range(200):
        state = (await client.get(f"{base}/imports/{state['id']}", headers=headers)).json()
        if state["status"] != "running":
            break
        await asyncio.sleep(0.05)
    assert state["status"] == "done", state

    library = (await client.get(base, headers=headers)).json()
    assert library["dataSourceId"] == ds["id"]
    assert [(v["vocabularyId"], v["vocabularyVersion"], v["release"]) for v in library["vocabularies"]] == [
        ("LOINC", "LOINC 2.77", "v5.0 27-FEB-26"),
        ("SNOMED", "2025-02-01 SNOMED CT International Edition", "v5.0 27-FEB-26"),
    ]
    assert all(v["sizeBytes"] > 0 for v in library["vocabularies"])

    r = await client.post(f"{API}/data-sources/{ds['id']}/query", headers=headers,
                          json={"sql": "SELECT vocabulary_id, COUNT(*) AS n FROM concept GROUP BY 1 ORDER BY 1"})
    assert r.status_code == 200, r.text
    assert r.json()["rows"] == [{"vocabulary_id": "LOINC", "n": 1}, {"vocabulary_id": "SNOMED", "n": 2}]

    preview = (await client.post(f"{base}/inspect", headers=headers, json={"files": files})).json()
    assert {v["vocabularyId"]: v["libraryVersion"] for v in preview["vocabularies"]}["LOINC"] == "LOINC 2.77"

    assert (await client.delete(f"{base}/vocabularies/LOINC", headers=headers)).status_code == 204
    r = await client.post(f"{API}/data-sources/{ds['id']}/query", headers=headers,
                          json={"sql": "SELECT DISTINCT vocabulary_id FROM concept"})
    assert r.json()["rows"] == [{"vocabulary_id": "SNOMED"}]
    assert [v["vocabularyId"] for v in (await client.get(base, headers=headers)).json()["vocabularies"]] == ["SNOMED"]
