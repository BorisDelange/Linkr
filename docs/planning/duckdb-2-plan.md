# DuckDB 2.0 on the server

Tried on `feature/oracle-mssql-testdata` (2026-10-30) and reverted: DuckDB 2.0.0 was
nine days old, and it changed things silently. Wait for a 2.0.x patch release.

## Why move

Less pressing since app queries reach Oracle through its own driver
(`oracle_client`, computed by Oracle). What 2.0 would still bring: the paths that
read through the extension (user SQL in editors, notebooks, ETL). `oracle_scanner` (krokozyab/quack-oracle) for DuckDB 1.5 is
0.2.2: it attaches only the login's own schema, has no READ_ONLY, pushes nothing
down, so Linkr reads Oracle through views over `oracle_query` that fetch whole
tables (`community_engines._oracle_views`). The build for 2.0 (0.6.x) attaches any
schema READ_ONLY (`SCHEMA` option) with filter, aggregate, join and top-N pushdown,
and `SET oracle_unconstrained_number`. SQL Server's `mssql` exists for 1.5, but that
build always encrypts **without verifying the server's certificate** (its secret
takes only `use_encrypt`; `TrustServerCertificate=no` is refused): the 2.0 build
verifies it, and the form would then get a "trust the server certificate" option.

## What 2.0 broke (all found by the API suite or the database matrix)

| Change | Where it bites | Fix that was applied, then reverted |
|---|---|---|
| New files in 2.0's storage format, unreadable by 1.x (DuckDB-WASM, R/Python envs) | managed databases, ETL targets, cohort derivations | `storage_compatibility_version = 'v1.5.0'` on every server connection |
| Division by zero raises instead of NULL | any app query with a ratio; diverges from the browser | `error_on_division_by_zero = false` |
| `tokenize` reports comments as tokens | **security**: `FORCE/**/INSTALL` slipped past `_leading_match` | `_tokens` drops comments — **kept**, harmless on 1.5 |
| `COPY FROM DATABASE` parsed as PRAGMA | **security**: the ETL guard checked COPY_DATABASE | keyword check — **kept** |
| `pg_clear_cache` renamed `postgres_clear_cache` | the stale-catalog retry of every Postgres query | rename in `_ENGINES` |
| `Relation.fetchone()` removed; a connection refuses new work while a result is unfinished | `dataset_parser` preview and type inference | `execute(...).fetchall()[0]` |
| `fetch_arrow_table` → `to_arrow_table` | `_run_to_arrow`, cohort derivation | rename (both exist on 1.5.5) |
| `COPY FROM DATABASE` copies blocks (60 M rows in 0.08 s) | a compaction's cancel never landed | re-check the cancel before the swap |
| Python ≥ 3.11 | — | the API runs 3.12 |

On 1.5, the `mssql` build fails a `NOT MATERIALIZED` CTE read twice (`mssql_catalog_scan does not exist`): Linkr drops the hint on SQL Server connections (`_materialization_left_to_duckdb`) — check whether 2.0's build still needs it. Known limit of `oracle_scanner` 0.6.0 on 2.0, the same bug: `WITH … AS NOT MATERIALIZED` read twice
fails (`oracle_attached_scan does not exist`, 9 of 46 matrix queries); it reads
`NUMBER(19..38)` and `FLOAT` as text whatever the settings (cast back in views).

## When moving

- Bump `duckdb` in `apps/api/pyproject.toml`, rerun the API suite and
  `npm run test:matrix -- --spe --engines parquet,duckdb,sqlite,postgresql,sqlserver,oracle`.
- Reapply the table's fixes; switch Oracle to the READ_ONLY attach with `SCHEMA`
  and typed views over the attached tables (pushdown kept on uncast columns).
- The browser stays on DuckDB-WASM 1.x until a 2.x build exists: keep the 1.x
  storage format and division semantics on the server until then.
