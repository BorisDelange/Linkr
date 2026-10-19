# Database matrix

Every query the app sends to a database, run on every engine Linkr reads,
compared with DuckDB's answer on the same data as Parquet. An engine that answers
differently, or refuses the SQL, is a bug in the builder or in the connector.
Overview and commands: [docs/testing.md § Database matrix](../../docs/testing.md#database-matrix).

| File | Role |
|---|---|
| `build-corpus.ts` | The app's SQL: the real builders on the database's mapping, relations injected |
| `matrix.py` | `facts` (what the queries need from the data), `upsample` (×N patients), `load` (the data into an engine) |
| `engines.py` | The engines, how Linkr reaches each one, the read-only login it is given |
| `test_matrix.py` | One test per (query, engine), through `apps/api`'s `db_connect`; writes the report |
| `run-in-container.sh` | The SPE simulation's `matrix-runner`: load, then pytest, inside the SPE |

`scripts/test-matrix.mjs` ties them together; run it through `npm run test:matrix`.

## Adding to it

- **A query builder**: one `add(key, builderName, sql)` in `build-corpus.ts`
  per variant that changes the SQL's shape. Mark it `ordered` when the app
  relies on the rows' order.
- **An engine**: its reach in `engines.py` (`linkr_config`, and for a loaded
  engine `admin_config` + `read_only_grants`), its load in `matrix.py`, its
  container in `docker/spe-sim/docker-compose.yml`, its wait in
  `run-in-container.sh`.
- **Other data**: `--data <folder>` takes any OMOP Parquet folder; `facts`
  expects the OMOP tables it names (`EVENT_TABLES`).

## Reading a difference

`report.json` keeps, for each `different` query, the first row that differs on
both sides. Values are compared after normalisation: numbers rounded to six
decimals, timestamps to the second, unordered results sorted. A difference that
survives that is real.
