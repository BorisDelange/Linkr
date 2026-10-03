# Benches

Manual, not run in CI. They need disk (≈15 GB per billion rows) and minutes.

## Concept counts, patient lookups, Data overview — `bench_concepts.py`

Generates a synthetic OMOP Parquet folder (person, concept, measurement,
condition_occurrence, drug_exposure; one patient holding ~2 % of the rows),
then counts the concept list through the server's own functions
(`concept_cache_fs.write_manifest` / `write_unit` / `assemble`), unit by unit,
checks the result against a brute-force count, and times one patient's lookup.

```bash
# 1. Export the SQL the app sends (written to scripts/bench/sql.json)
cd apps/web && npx vitest run -c ../../scripts/bench/vitest.config.ts

# 2. Run (apps/api venv)
cd apps/api && PYTHONPATH=. .venv/bin/python ../../scripts/bench/bench_concepts.py \
  --work /tmp/linkr-bench --rows 300000000 --patients 1000000 --variant unsorted
```

`--variant sorted` writes the files ordered by patient then date; `--old` also
times the former single-query count; `--no-check` skips the brute-force check
(slow at a billion rows); `--overview-only` skips the counts and times the Data
overview's queries for the heavy patient (inventory, density at three zooms,
one day of events). The slice count is the power of two nearest to what
`planSlices` would choose for `--slice-rows`.

Reference (2026-10-02, Mac 8 cores / 16 GB / SSD):

| | Unsorted | Sorted |
|---|---|---|
| 1 B rows, former single query | 320 s | — |
| 1 B rows, `records` step | 10 s | — |
| 1 B rows, a 100 M-row patient slice | 16–33 s | — |
| 300 M rows, every unit | 31 s | 12 s |
| 300 M rows, one patient's measurements | 0.40 s | 0.03 s |

Data overview, heavy patient (2 % of the rows), one density query per view:

| | 300 M sorted | 1 B unsorted |
|---|---|---|
| Inventory | 0.11 s | 6.3 s |
| Density, whole record / a week / a day | 0.03–0.06 s | ~5 s each |
| One day of events | 0.03 s | 4.5 s |

Unsorted, every read is a full scan of the event tables: the layout, not the
query, is what decides whether the overview follows a pan.

## A database to try the patient views by hand — `make_overview_db.py`

Writes a full OMOP CDM 5.4 Parquet folder (every column of the DDL, one folder
per table) with few patients and one very heavy one: patient 1 has three
hospitalisations, two ICU stays monitored at 1 Hz (12 vitals) and one more in
the last hospitalisation — about 51 M measurement rows — plus labs, drugs,
conditions, procedures and daily notes. Patients 2–20 have one short
hospitalisation each. Concepts are local (vocabulary "Linkr synthetic").

```bash
cd apps/api && .venv/bin/python ../../scripts/bench/make_overview_db.py --out ~/linkr-test-data/omop-heavy-patient
```

About 20 s and 420 MB. `--unsorted` shuffles the rows, to see the layout
warning and the cost of an unsorted table; `--hz` changes the monitoring rate;
`--patients` the number of patients. Add it as a Parquet folder database with
the OMOP CDM 5.4 schema.
