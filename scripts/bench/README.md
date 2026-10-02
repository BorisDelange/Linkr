# Benches

Manual, not run in CI. They need disk (≈15 GB per billion rows) and minutes.

## Concept counts and patient lookups — `bench_concepts.py`

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
(slow at a billion rows). The slice count is the power of two nearest to what
`planSlices` would choose for `--slice-rows`.

Reference (2026-10-02, Mac 8 cores / 16 GB / SSD):

| | Unsorted | Sorted |
|---|---|---|
| 1 B rows, former single query | 320 s | — |
| 1 B rows, `records` step | 10 s | — |
| 1 B rows, a 100 M-row patient slice | 16–33 s | — |
| 300 M rows, every unit | 31 s | 12 s |
| 300 M rows, one patient's measurements | 0.40 s | 0.03 s |
