"""The demo ETL pipeline (MIMIC-IV demo → OMOP CDM 5.4) run whole on the server,
script by script through the `etl-run` route, as the Scripts tab's Run all does.

Its vocabulary fill script is the one the Vocabulary tab generates today
(`tests/etl-demo/fill-vocabulary-script.ts`, passed in LINKR_ETL_DEMO_FILL_SCRIPT),
not the copy the pipeline's repository holds: that older version builds SQL from
text with query(), which a pipeline script may no longer run.

Needs the demo seed (`npm run data:fetch`); `npm run test:etl` builds the fill
script and runs this file. Skipped elsewhere.

The figures are the open MIMIC-IV demo's: they move when linkr-public-content
changes the pipeline or the demo, and are updated with it.
"""

import json
import os
from pathlib import Path

import duckdb
import pytest

from app.config import settings
from app.core import deferred
from app.services.data import managed_db

pytestmark = [pytest.mark.slow, pytest.mark.timeout(1200)]

API = "/api/v1"
SEED = Path(__file__).resolve().parents[2] / "web/public/data/seed/default"
PIPELINE = SEED / "etl/mimic-iv-demo-omop-cdm"
SOURCE = SEED / "databases/mimic-iv-demo/data"
FILL_SCRIPT = "89_fill_vocabulary.sql"
FILL = os.environ.get("LINKR_ETL_DEMO_FILL_SCRIPT")
# Where the run's figures are written, for `npm run test:etl` to print.
REPORT = os.environ.get("LINKR_ETL_DEMO_REPORT")

# OMOP vocabulary tables: they describe concepts, the CDM tables use them.
VOCAB_TABLES = {
    "concept", "concept_ancestor", "concept_class", "concept_relationship", "concept_synonym",
    "domain", "drug_strength", "relationship", "vocabulary", "source_to_concept_map",
}


def _scripts() -> list[str]:
    tree = json.loads((PIPELINE / "scripts/_tree.json").read_text())
    files = [
        n for n in tree
        if n.get("type") == "file" and n["path"].endswith(".sql") and "/" not in n["path"] and not n.get("disabled")
    ]
    return [n["path"] for n in sorted(files, key=lambda n: (n.get("order", 0), n["path"]))]


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _server_folder(client, headers, ws: str, alias: str, entity: str) -> str:
    """A seed database as the server reads it in place: a Parquet folder."""
    db = SEED / "databases" / entity
    r = await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": alias, "name": {"en": alias}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "serverPath": str(db / "data")},
        "schemaMapping": json.loads((db / "mapping.json").read_text()),
    })
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.fixture
def demo_pipeline(monkeypatch):
    if not FILL:
        pytest.skip("run through `npm run test:etl`, which generates the fill script")
    if not (PIPELINE / "scripts/_tree.json").exists():
        pytest.skip("no demo seed: npm run data:fetch")
    monkeypatch.setattr(settings, "fs_browse_roots", str(SEED))
    # Answer every script inline: past it, the route hands the run to a job.
    monkeypatch.setattr(deferred, "WAIT_SECONDS", 3600.0)
    return Path(FILL).read_text()


async def test_the_demo_pipeline_builds_the_omop_cdm(client, demo_pipeline):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "ETL demo"}})).json()["id"]
    source = await _server_folder(client, headers, ws, "mimic_iv_demo", "mimic-iv-demo")
    vocab = await _server_folder(client, headers, ws, "mimic_iv_demo_vocab", "mimic-iv-demo-omop")
    r = await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "mimic_iv_demo_omop", "name": {"en": "MIMIC-IV Demo OMOP"},
        "sourceType": "database", "connectionConfig": {"engine": "duckdb"},
    })
    target = r.json()["id"]
    ddl = (SEED / "schemas/omop-cdm-5-4/schema.ddl").read_text()
    r = await client.post(f"{API}/data-sources/{target}/create-from-ddl", headers=headers, json={"ddl": ddl})
    assert r.status_code == 200, r.text

    mapping_data = {p.stem: p.read_text() for p in sorted((PIPELINE / "mapping").glob("*.csv"))}
    roles = {"source": source, "vocab": vocab}

    async def run(sql: str):
        return await client.post(f"{API}/data-sources/{target}/etl-run", headers=headers, json={
            "sql": sql, "roles": roles, "mappingData": mapping_data,
        })

    report: dict = {}
    scripts = _scripts()
    report["scripts"] = len(scripts)
    assert FILL_SCRIPT in scripts and "90_tests.sql" in scripts

    # A pipeline still holding the fill script that predates the server-provided
    # scan is refused, with the way out.
    r = await run("SELECT DISTINCT concept_id FROM query(getvariable('linkr_used_concepts_sql'))")
    assert r.status_code == 400, r.text
    assert "regenerate it from the pipeline's Vocabulary tab" in r.json()["detail"]

    for name in scripts:
        sql = demo_pipeline if name == FILL_SCRIPT else (PIPELINE / "scripts" / name).read_text()
        r = await run(sql)
        assert r.status_code == 200, f"{name}: {r.text[:2000]}"
        if name == "90_tests.sql":
            checks = r.json()["rows"]
            # The mapping-rate thresholds are set for a full Athena vocabulary;
            # the demo's holds only redistributable terminologies (SNOMED limited
            # to the Global Patient Set), so ICD codes map below them. Computed,
            # not judged.
            failed = [c for c in checks if c["status"] == "fail" and c["check_group"] != "rate"]
            assert failed == [], f"90_tests.sql checks failed: {failed}"
            rates = [c for c in checks if c["check_group"] == "rate"]
            assert len(rates) == 3 and all(c["total"] > 0 for c in rates), rates
            report["checks"] = {s: sum(c["status"] == s for c in checks) for s in ("pass", "known", "info", "fail")}
            report["mappingRates"] = {c["check_name"]: c["pct_ok"] for c in rates}

    path = managed_db.path_of(target, {"engine": "duckdb", "managed": True})
    con = duckdb.connect(str(path), read_only=True)
    try:
        def one(sql: str):
            return con.execute(sql).fetchone()[0]

        def source(sql: str):
            return duckdb.sql(sql.replace("{hosp}", str(SOURCE / "hosp")).replace("{note}", str(SOURCE / "note"))).fetchone()[0]

        # The demo's 100 patients, one observation period each, a death for
        # every date of death, a visit for every admission, a note per discharge.
        assert one("SELECT count(*) FROM person") == source("SELECT count(*) FROM '{hosp}/patients.parquet'") == 100
        assert one("SELECT count(*) FROM observation_period") == 100
        assert one("SELECT count(DISTINCT person_id) FROM observation_period") == 100
        assert one("SELECT count(*) FROM death") == source("SELECT count(dod) FROM '{hosp}/patients.parquet'")
        assert one("SELECT count(*) FROM visit_occurrence WHERE visit_occurrence_id IN "
                   f"(SELECT hadm_id FROM '{SOURCE / 'hosp/admissions.parquet'}')") \
            == source("SELECT count(*) FROM '{hosp}/admissions.parquet'")
        assert one("SELECT count(DISTINCT person_id) FROM visit_detail") == 100
        assert one("SELECT count(*) FROM note") == source("SELECT count(*) FROM '{note}/discharge.parquet'")
        for table in ("measurement", "condition_occurrence", "drug_exposure", "procedure_occurrence", "observation",
                      "condition_era", "drug_era"):
            assert one(f"SELECT count(*) FROM {table}") > 0, table
        assert one("SELECT count(*) FROM cdm_source") == 1

        # Pruned to what the CDM uses, and everything it uses that the
        # vocabulary holds is there. Standard ids only: the source concepts
        # (>= 2 000 000 000) come from the mapping project, not the vocabulary.
        vocabulary = f"read_parquet('{SEED / 'databases/mimic-iv-demo-omop/data/concept.parquet'}')"
        full = one(f"SELECT count(*) FROM {vocabulary} WHERE concept_id < 2000000000")
        kept = one("SELECT count(*) FROM concept WHERE concept_id < 2000000000")
        assert 0 < kept < full
        columns = con.execute(
            "SELECT table_name, column_name FROM duckdb_columns() "
            "WHERE database_name = current_database() AND ends_with(column_name, '_concept_id') "
            "ORDER BY ALL"
        ).fetchall()
        scans = [
            f"SELECT '{t}.{c}' AS col, TRY_CAST(\"{c}\" AS BIGINT) AS id FROM \"{t}\""
            for t, c in columns if t not in VOCAB_TABLES and t != "etl_test_results"
        ]
        assert scans
        con.execute(f"CREATE TEMP TABLE used AS SELECT DISTINCT col, id FROM ({' UNION ALL '.join(scans)}) WHERE id IS NOT NULL")
        missing = con.execute(
            f"SELECT col, id FROM used WHERE id NOT IN (SELECT concept_id FROM concept) "
            f"AND id IN (SELECT concept_id FROM {vocabulary}) ORDER BY ALL"
        ).fetchall()
        assert missing == [], f"concept ids used, in the vocabulary, but not copied (column, id): {missing}"
        # Hard-coded SNOMED ids (routes, operators, language, discharge) the
        # demo's redistributable vocabulary leaves out: nothing to copy them from.
        outside = one("SELECT count(DISTINCT id) FROM used WHERE id NOT IN (SELECT concept_id FROM concept)")
        # What the run left: the staging tables are dropped by 92_cleanup.sql.
        assert one(
            "SELECT count(*) FROM duckdb_tables() WHERE database_name = current_database() "
            "AND (starts_with(table_name, 'src_') OR starts_with(table_name, 'map_') OR starts_with(table_name, 'tmp_'))"
        ) == 0
        report["rows"] = {t: one(f"SELECT count(*) FROM {t}") for t in (
            "person", "death", "observation_period", "visit_occurrence", "visit_detail",
            "condition_occurrence", "drug_exposure", "procedure_occurrence", "measurement",
            "observation", "specimen", "device_exposure", "note", "condition_era", "drug_era",
        )}
        report["concepts"] = {"kept": kept, "vocabulary": full, "usedOutsideVocabulary": outside}
        if REPORT:
            Path(REPORT).write_text(json.dumps(report, indent=2))
    finally:
        con.close()
