"""Synthetic OMOP datamart as a Parquet folder (one folder per table), to reproduce heavy
queries in the SPE simulation.

    python3 docker/spe-sim/make-datamart.py [rows] [patients] [out]

rows      measurement + condition_occurrence rows (default 20,000,000 — a few seconds per
          catalog step; 240,000,000 reproduces the 504 of docs/planning/heavy-jobs-plan.md §4)
patients  default rows / 100
out       default docker/spe-sim/datamart/omop-<rows in millions>m (gitignored)

Needs the duckdb Python package (`pip install duckdb`). In Linkr: a DuckDB database on the
server, path /datamart/<folder>, schema OMOP.
"""
import sys
import time
from pathlib import Path

import duckdb

rows = int(sys.argv[1]) if len(sys.argv) > 1 else 20_000_000
patients = int(sys.argv[2]) if len(sys.argv) > 2 else max(rows // 100, 1)
root = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(__file__).parent / "datamart" / f"omop-{rows // 1_000_000}m"
visits = patients * 5

con = duckdb.connect()
con.execute("SET preserve_insertion_order = false")


def write(name: str, sql: str) -> None:
    (root / name).mkdir(parents=True, exist_ok=True)
    t = time.time()
    con.execute(f"COPY ({sql}) TO '{root / name / 'data_0.parquet'}' (FORMAT PARQUET)")
    print(f"{name}: {time.time() - t:.1f} s", flush=True)


write("person", f"""
    SELECT r + 1 AS person_id, 1940 + r % 60 AS year_of_birth,
           CASE WHEN r % 2 = 0 THEN 8507 ELSE 8532 END AS gender_concept_id
    FROM range({patients}) t(r)""")
# Five visits per patient, roughly 400 days apart.
write("visit_occurrence", f"""
    SELECT r + 1 AS visit_occurrence_id, r % {patients} + 1 AS person_id,
           TIMESTAMP '2010-01-01' + INTERVAL (r // {patients} * 400 + r % 97) DAY AS visit_start_datetime,
           TIMESTAMP '2010-01-01' + INTERVAL (r // {patients} * 400 + r % 97 + 1 + r % 20) DAY AS visit_end_datetime
    FROM range({visits}) t(r)""")
write("concept", """
    SELECT r AS concept_id, 'Concept ' || r AS concept_name, 'Domain' || (r % 5) AS domain_id
    FROM range(1, 5001) t(r)""")
# Events spread with hash() so the counts are not trivially sorted; a third carry a source concept.
for name, share, concept, source, date in (
    ("measurement", 0.8, "measurement_concept_id", "measurement_source_concept_id", "measurement_datetime"),
    ("condition_occurrence", 0.2, "condition_concept_id", "condition_source_concept_id", "condition_start_datetime"),
):
    write(name, f"""
        SELECT hash(r) % {patients} + 1 AS person_id,
               hash(r * 7) % 5000 + 1 AS {concept},
               CASE WHEN r % 3 = 0 THEN hash(r * 11) % 5000 + 1 END AS {source},
               hash(r) % {patients} + {patients} * (hash(r * 13) % 5) + 1 AS visit_occurrence_id,
               TIMESTAMP '2010-01-01' + INTERVAL (hash(r * 13) % 5 * 400 + hash(r * 17) % 97 + hash(r * 19) % 20) DAY AS {date}
        FROM range({int(rows * share)}) t(r)""")
print(f"→ {root}")
