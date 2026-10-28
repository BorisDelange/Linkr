"""Suggestion engines: the worker's syntactic scoring and semantic search, the
registry's index state, and completing a method's rows."""

import csv
import json
import subprocess
import sys
from pathlib import Path

import duckdb
import numpy as np
import pytest

from app.services.data import scores_service
from app.services.suggestions import registry, worker

WORKER = Path(worker.__file__)


def _concepts(path: Path) -> str:
    con = duckdb.connect()
    con.execute(f"""
        COPY (SELECT * FROM (VALUES
            (1, 'Heart rate', 'LOINC', 'Measurement', 'Clinical Observation', 'S', NULL),
            (2, 'Body temperature', 'LOINC', 'Measurement', 'Clinical Observation', 'S', NULL),
            (3, 'Heart rate variability', 'LOINC', 'Measurement', 'Clinical Observation', NULL, NULL),
            (4, 'Hearts rated', 'SNOMED', 'Observation', 'Finding', 'S', 'D'),
            (5, 'Paracetamol', 'RxNorm', 'Drug', 'Ingredient', 'S', NULL)
        ) t(concept_id, concept_name, vocabulary_id, domain_id, concept_class_id, standard_concept, invalid_reason))
        TO '{path}' (FORMAT PARQUET)
    """)
    con.close()
    return str(path)


def _sources(path: Path, rows: list[tuple[str, str, str]]) -> str:
    con = duckdb.connect()
    con.execute("CREATE TABLE s (vocabulary_id VARCHAR, concept_code VARCHAR, concept_name VARCHAR)")
    if rows:
        con.executemany("INSERT INTO s VALUES (?, ?, ?)", rows)
    con.execute(f"COPY s TO '{path}' (FORMAT PARQUET)")
    con.close()
    return str(path)


def _run(tmp_path: Path, command: str, spec: dict) -> dict:
    spec_path = tmp_path / f"{command}.json"
    spec_path.write_text(json.dumps(spec))
    out = subprocess.run(
        [sys.executable, str(WORKER), command, str(spec_path)], capture_output=True, text=True, check=True,
    ).stdout
    line = next(ln for ln in out.splitlines() if ln.startswith("@@result "))
    return json.loads(line.split(" ", 1)[1])


def _read_csv(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def test_target_where_scopes():
    where = worker.target_where({"onlyStandard": True, "onlyValid": True, "domains": ["Measurement"]})
    assert "standard_concept = 'S'" in where
    assert "invalid_reason IS NULL" in where
    assert "domain_id IN ('Measurement')" in where
    assert "O''Brien" in worker.target_where({"vocabularies": ["O'Brien"]})


def test_encoded_text_templates():
    assert worker.encoded_text("name_class", "Heart rate", "LOINC", "Clinical Observation") == \
        "Heart rate [LOINC / Clinical Observation]"
    assert worker.encoded_text("name_class", "Heart rate", "LOINC", "") == "Heart rate [LOINC]"
    assert worker.encoded_text("name", "Heart rate", "LOINC", "Clinical Observation") == "Heart rate"


def test_syntactic_scores_respect_the_target_scope(tmp_path):
    found = _run(tmp_path, "score", {
        "sourcesPath": _sources(tmp_path / "s.parquet", [("local", "HR", "Fréquence cardiaque"), ("local", "T", "heart rate")]),
        "conceptPaths": [_concepts(tmp_path / "concept.parquet")],
        "filters": {"onlyStandard": True, "onlyValid": True, "domains": ["Measurement"]},
        "topK": 2,
        "methods": ["syntactic/jaro-winkler", "syntactic/token-sort"],
        "semantic": None,
        "outDir": str(tmp_path / "out"),
    })
    jw = found["methods"]["syntactic/jaro-winkler"]
    assert jw["rows"] == 4  # 2 sources x top 2 of the 2 standard valid Measurement concepts
    rows = _read_csv(jw["path"])
    assert {r["concept_id"] for r in rows} == {"1", "2"}
    best = max((r for r in rows if r["source_concept_code"] == "T"), key=lambda r: float(r["score"]))
    assert best["concept_id"] == "1" and float(best["score"]) == 1.0
    assert all(r["equivalence"] == "skos:exactMatch" for r in rows)


def test_score_reports_a_checkpoint_per_chunk_and_a_semantic_list_of_its_own(tmp_path):
    spec = {
        "sourcesPath": _sources(tmp_path / "s.parquet", [("local", "T", "heart rate")]),
        "semanticSourcesPath": _sources(tmp_path / "m.parquet", []),
        "conceptPaths": [_concepts(tmp_path / "concept.parquet")],
        "filters": {}, "topK": 1, "methods": ["syntactic/jaro-winkler"],
        "semantic": {"method": "semantic/x"}, "outDir": str(tmp_path / "out"),
    }
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))
    out = subprocess.run(
        [sys.executable, str(WORKER), "score", str(spec_path)], capture_output=True, text=True, check=True,
    ).stdout.splitlines()
    assert '@@checkpoint {"stage": "syntactic", "done": 1}' in out
    # Its semantic list is empty, so no model is loaded (none could be, here).
    result = json.loads(next(ln for ln in out if ln.startswith("@@result ")).split(" ", 1)[1])
    assert list(result["methods"]) == ["syntactic/jaro-winkler"]


def test_a_resumed_score_reports_progress_from_where_its_pause_stopped(tmp_path):
    spec = {
        "sourcesPath": _sources(tmp_path / "s.parquet", [("local", "T", "heart rate")]),
        "conceptPaths": [_concepts(tmp_path / "concept.parquet")],
        "filters": {}, "topK": 1, "methods": ["syntactic/jaro-winkler"], "semantic": None,
        "outDir": str(tmp_path / "out"), "progress": {"done": 2, "total": 4},
    }
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))
    out = subprocess.run(
        [sys.executable, str(WORKER), "score", str(spec_path)], capture_output=True, text=True, check=True,
    ).stdout.splitlines()
    assert [ln for ln in out if ln.startswith("@@progress ")] == ["@@progress 75"]


def test_ngram_idf_ranks_the_closest_name_first():
    index = worker.NgramIdfIndex(["Heart rate", "Body temperature", "Heart rate variability"])
    assert index.top_k("heart rate", 1)[0][0] == 0


def test_top_k_merge_keeps_the_best_across_blocks():
    best_s = np.full((1, 0), -np.inf, dtype=np.float32)
    best_i = np.zeros((1, 0), dtype=np.int64)
    best_s, best_i = worker.top_k_merge(best_s, best_i, np.array([[0.1, 0.9, 0.5]], np.float32), np.array([10, 11, 12]), 2)
    best_s, best_i = worker.top_k_merge(best_s, best_i, np.array([[0.95, 0.2]], np.float32), np.array([20, 21]), 2)
    assert sorted(best_i[0].tolist()) == [11, 20]


def test_search_index_reads_every_file_and_filters(tmp_path):
    vecs = np.eye(3, dtype=np.float16)
    for name, ids, block in (("a", [1, 2], vecs[:2]), ("b", [3], vecs[2:])):
        np.save(tmp_path / f"{name}.ids.npy", np.array(ids, dtype=np.int64))
        np.save(tmp_path / f"{name}.vec.npy", block)
    files = [(str(tmp_path / f"{n}.ids.npy"), str(tmp_path / f"{n}.vec.npy")) for n in ("a", "b")]
    query = np.array([[0.1, 0.2, 0.9]], dtype=np.float32)
    _, ids = worker.search_index(files, query, 2, None)
    assert ids[0].tolist() == [3, 2]
    _, ids = worker.search_index(files, query, 2, np.array([1, 2], dtype=np.int64))
    assert ids[0].tolist() == [2, 1]


def test_csv_fields_are_quoted():
    assert worker.csv_field('a,"b"') == '"a,""b"""'
    assert worker.csv_field(None) == ""


def test_index_state_built_stale_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(registry, "root", lambda ws: tmp_path / ws)
    config = {"id": "c1", "slug": "biolord", "filters": {}}
    inventory = [
        {"vocabularyId": "LOINC", "importedAt": "t2"},
        {"vocabularyId": "SNOMED", "importedAt": "t1"},
        {"vocabularyId": "UCUM", "importedAt": "t1"},
    ]
    registry.save_manifest("ws", "c1", {"vocabularies": {
        "LOINC": {"count": 2, "importedAt": "t1"},
        "SNOMED": {"count": 1, "importedAt": "t1"},
    }})
    for key in ("vocab-LOINC", "vocab-SNOMED"):
        ids, vec = registry.index_files("ws", "c1", key)
        ids.write_bytes(b"x")
        vec.write_bytes(b"x")
    states = {s["vocabularyId"]: s["status"] for s in registry.index_state("ws", config, inventory)}
    assert states == {"LOINC": "stale", "SNOMED": "built", "UCUM": "missing"}
    assert len(registry.usable_index_files("ws", config, inventory)) == 2
    only = {**config, "filters": {"vocabularies": ["UCUM"]}}
    assert [s["vocabularyId"] for s in registry.index_state("ws", only, inventory)] == ["UCUM"]


@pytest.mark.parametrize("slug,ok", [("biolord", True), ("sap-bert.v2", True), ("Bio", False), ("a/b", False), ("", False)])
def test_slug_is_a_method_segment(slug, ok):
    assert registry.valid_slug(slug) is ok
    if ok:
        assert scores_service.csv_path_for_method(registry.method_for({"slug": slug})) is not None


def test_extend_method_csv_keeps_rows_of_concepts_not_rescored(tmp_path):
    existing = tmp_path / "scores.parquet"
    con = duckdb.connect()
    con.execute(f"""
        COPY (SELECT * FROM (VALUES
            ('v', 'A', 1::BIGINT, 'semantic/biolord', 0.5::DOUBLE, 'skos:exactMatch', NULL, '2026'),
            ('v', 'B', 2::BIGINT, 'semantic/biolord', 0.6::DOUBLE, 'skos:exactMatch', NULL, '2026'),
            ('v', 'A', 9::BIGINT, 'ai/model', 0.9::DOUBLE, 'skos:closeMatch', 'why', '2026')
        ) t(source_vocabulary_id, source_concept_code, concept_id, method, score, equivalence, comment, created_at))
        TO '{existing}' (FORMAT PARQUET)
    """)
    con.close()
    new = tmp_path / "new.csv"
    new.write_text(worker.CSV_HEADER + "v,A,3,0.700,skos:exactMatch,,2027\n")
    out = tmp_path / "out.csv"
    assert scores_service.extend_method_csv(str(existing), "semantic/biolord", str(new), str(out)) == 2
    rows = {(r["source_concept_code"], r["concept_id"]) for r in _read_csv(str(out))}
    assert rows == {("A", "3"), ("B", "2")}
    assert scores_service.extend_method_csv(None, "semantic/biolord", str(new), str(out)) == 1


# --- Routes -------------------------------------------------------------------

API = "/api/v1"


async def _library_workspace(client, headers) -> str:
    """A workspace whose vocabulary library holds the LOINC and SNOMED of the
    vocabulary-library tests' export."""
    import asyncio as aio

    from app.services import blob_store
    from app.services import vocabulary_library as lib
    from tests.test_vocabulary_library import _export

    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "vocab", "name": "Vocabularies", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "vocabularyLibrary": True},
        "schemaMapping": {"knownTables": list(lib.LIBRARY_TABLES)}, "isVocabularyReference": True,
    })
    files = []
    for name, path in _export():
        sha, _ = await blob_store.store_bytes(Path(path).read_bytes())
        files.append({"fileName": name, "sha": sha})
    state = (await client.post(f"{API}/workspaces/{ws}/vocabulary-library/import", headers=headers, json={
        "source": {"files": files}, "vocabularies": ["LOINC", "SNOMED"]})).json()
    await aio.gather(lib.import_state(state["id"]).task, return_exceptions=True)
    return ws


async def _file_project(client, headers, ws: str) -> str:
    from app.services import blob_store

    p = (await client.post(f"{API}/mapping-projects", headers=headers, json={
        "id": "mp-scores", "workspaceId": ws, "name": {"en": "Scores"}, "description": {}, "sourceType": "file",
        "conceptSetIds": [],
        "fileSourceData": {
            "fileName": "src.csv", "columns": ["vocab", "code", "label"], "rows": [],
            "columnMapping": {"terminologyColumn": "vocab", "conceptCodeColumn": "code", "conceptNameColumn": "label"},
        },
    })).json()
    sha, _ = await blob_store.store_bytes(b"vocab,code,label\nREA,hr,heart rate\nREA,pulse,pulse radial\n")
    await client.post(f"{API}/mapping-projects/{p['id']}/raw-file", headers=headers, json={"sha": sha, "fileName": "src.csv"})
    return p["id"]


async def test_compute_route_scores_a_project_and_keeps_ai_rows(client):
    from app.services.execution import jobs
    from tests.test_vocabulary_library import _admin_headers

    headers = await _admin_headers(client)
    ws = await _library_workspace(client, headers)
    pid = await _file_project(client, headers, ws)
    base = f"{API}/mapping-projects/{pid}/scores"
    await client.post(f"{base}/append", headers=headers, json={"rows": [{
        "sourceVocabularyId": "REA", "sourceConceptCode": "hr", "conceptId": 1, "method": "ai/model",
        "score": 0.9, "equivalence": "skos:exactMatch", "comment": "same",
    }]})

    engines = (await client.get(f"{API}/workspaces/{ws}/suggestion-engines", headers=headers)).json()
    assert engines["vocabularies"] == ["LOINC", "SNOMED"] and engines["configs"] == []

    assert (await client.post(f"{base}/compute", headers=headers, json={"methods": ["syntactic/nope"]})).status_code == 400
    assert (await client.post(f"{base}/compute", headers=headers, json={"methods": []})).status_code == 400
    r = await client.post(f"{base}/compute", headers=headers, json={"methods": ["syntactic/jaro-winkler"], "topK": 1})
    assert r.status_code == 200, r.text
    job_id = r.json()["id"]
    assert (await client.post(f"{base}/compute", headers=headers, json={"methods": ["syntactic/token-sort"]})).status_code == 409
    # A reopened Compute tab finds the run again.
    assert (await client.get(f"{base}/compute", headers=headers)).json()["jobId"] == job_id
    await jobs._tasks[job_id]
    assert (await client.get(f"{base}/compute", headers=headers)).json() == {"jobId": None, "paused": None}
    job = (await client.get(f"{API}/jobs/{job_id}", headers=headers)).json()
    assert job["status"] == "done", job["logTail"]
    assert job["result"] == {"syntactic/jaro-winkler": 2}

    rows = (await client.post(f"{base}/query", headers=headers, json={"vocabularyId": "REA", "conceptCode": "hr"})).json()
    assert {(r["method"], r["concept_id"]) for r in rows} == {("ai/model", 1), ("syntactic/jaro-winkler", 1)}

    # Only the concepts the method lacks: nothing left, the file is unchanged.
    r = await client.post(f"{base}/compute", headers=headers, json={"methods": ["syntactic/jaro-winkler"], "onlyMissing": True})
    if r.json()["id"] in jobs._tasks:
        await jobs._tasks[r.json()["id"]]
    job = (await client.get(f"{API}/jobs/{r.json()['id']}", headers=headers)).json()
    assert job["status"] == "done" and "already" in job["logTail"]


async def test_config_edit_drops_the_index_only_when_its_inputs_change(client, monkeypatch):
    from app.services.suggestions import tasks
    from tests.test_vocabulary_library import _admin_headers

    headers = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    registry.save(ws, {"models": [{"id": "m1", "name": "M", "source": "huggingface", "repoId": "a/b"}], "configs": []})
    base = f"{API}/workspaces/{ws}/suggestion-engines/configs"
    created = (await client.post(base, headers=headers, json={"modelId": "m1", "name": "Bio Lord"})).json()
    assert created["slug"] == "bio-lord" and created["method"] == "semantic/bio-lord"
    assert created["filters"]["domains"] == registry.DEFAULT_DOMAINS
    assert (await client.post(base, headers=headers, json={"modelId": "m1", "slug": "bio-lord"})).status_code == 409
    assert (await client.post(base, headers=headers, json={"modelId": "m1", "slug": "Bad/slug"})).status_code == 400

    manifest = registry.index_dir(ws, created["id"]) / "manifest.json"
    registry.save_manifest(ws, created["id"], {"vocabularies": {}})
    await client.patch(f"{base}/{created['id']}", headers=headers, json={"device": "cpu", "batchSize": 64})
    assert manifest.is_file()
    await client.patch(f"{base}/{created['id']}", headers=headers, json={"template": "name"})
    assert not manifest.exists()

    monkeypatch.setattr(tasks, "running_job", lambda key: "j" if key == f"index:{created['id']}" else None)
    assert (await client.delete(f"{base}/{created['id']}", headers=headers)).status_code == 409
    monkeypatch.undo()
    assert (await client.delete(f"{API}/workspaces/{ws}/suggestion-engines/models/m1", headers=headers)).status_code == 409
    assert (await client.delete(f"{base}/{created['id']}", headers=headers)).status_code == 204
    assert (await client.delete(f"{API}/workspaces/{ws}/suggestion-engines/models/m1", headers=headers)).status_code == 204


async def test_a_paused_computation_keeps_what_it_finished_and_resumes_the_rest(client, tmp_path):
    from app.core.database import async_session
    from app.services import mapping_project_service as svc
    from app.services import scores_export
    from app.services.execution import jobs
    from app.services.suggestions import tasks
    from tests.test_vocabulary_library import _admin_headers

    headers = await _admin_headers(client)
    ws = await _library_workspace(client, headers)
    pid = await _file_project(client, headers, ws)
    base = f"{API}/mapping-projects/{pid}/scores"
    assert (await client.post(f"{base}/compute/pause", headers=headers)).status_code == 409

    # Stopped after its first source concept: the row the worker wrote past that
    # checkpoint (pulse) is dropped, and pulse is what is left.
    out = tmp_path / "out"
    out.mkdir()
    (out / worker.method_file_name("syntactic/jaro-winkler")).write_text(
        worker.CSV_HEADER
        + "REA,hr,1,0.900,skos:exactMatch,,2026-01-01T00:00:00Z\n"
        + "REA,pulse,1,0.500,skos:exactMatch,,2026-01-01T00:00:00Z\n"
    )

    class Handle:
        async def log(self, _line: str) -> None:
            pass

    async def write(csvs):
        async with async_session() as db:
            await scores_export.replace_methods(db, await svc.get(db, pid), csvs)

    sources = [("REA", "hr", "heart rate"), ("REA", "pulse", "pulse radial")]
    params = {"methods": ["syntactic/jaro-winkler"], "topK": 1}
    await tasks._pause(
        Handle(), ws, pid, params, 2, None, out, {"syntactic/jaro-winkler": "syntactic"},
        {"syntactic": sources, "semantic": []}, {"syntactic": 1}, write,
    )

    async def methods_of(code: str) -> dict:
        rows = (await client.post(f"{base}/query", headers=headers, json={"vocabularyId": "REA", "conceptCode": code})).json()
        return {r["method"]: r["score"] for r in rows}

    assert await methods_of("hr") == {"syntactic/jaro-winkler": 0.9}
    assert await methods_of("pulse") == {}
    paused = (await client.get(f"{base}/compute", headers=headers)).json()["paused"]
    assert paused["params"] == params and (paused["total"], paused["done"]) == (2, 1)

    r = await client.post(f"{base}/compute/resume", headers=headers)
    assert r.status_code == 200, r.text
    await jobs._tasks[r.json()["id"]]
    assert (await client.get(f"{API}/jobs/{r.json()['id']}", headers=headers)).json()["status"] == "done"
    assert "syntactic/jaro-winkler" in await methods_of("pulse")
    assert await methods_of("hr") == {"syntactic/jaro-winkler": 0.9}  # resuming leaves what was done
    assert (await client.get(f"{base}/compute", headers=headers)).json()["paused"] is None
    assert (await client.post(f"{base}/compute/resume", headers=headers)).status_code == 409
