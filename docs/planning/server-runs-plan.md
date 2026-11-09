# Server-owned concept runs

The database Concepts tab statistics and the mapping project's source-concept
extraction are long runs (minutes to hours). In server mode the **browser** drives
them today: it ranks the concepts, packs the batches, posts them as query jobs, turns
each result into a profile and keeps the checkpoint. A reload kills that driver, and
the page has to guess what to follow again (kept jobs, `isJobGoingOn`,
`forgetStoppedJobs`, `isPageLeaving`…). Each guess has had its bug. On top of that a
DuckDB query can ignore its interrupt: "Stopping…" then lasts until the query is let
go, and its thread keeps the database's only connection.

This plan moves both runs to the server, as one durable run each, which the page only
observes. Client-only (WASM) mode keeps its browser loop unchanged.

## 1. What established tools do (sources in the research note, §8)

- **The run is a server resource, the client observes it.** Google AIP-151 and the
  Azure guidelines on long-running operations: the client reads a status and sends
  cancel; a reload re-reads it, there is nothing to reattach.
- **Checkpoint = last committed batch**, written in the same transaction as the
  batch's results. Spring Batch (the engine behind OHDSI WebAPI/Atlas) separates the
  logical run (JobInstance) from each attempt (JobExecution): *restart* = new run,
  *resume* = new attempt on the same run.
- **One active run per resource**, enforced by the database (partial unique index:
  PostgreSQL, and SQLite ≥ 3.8), not by an in-memory lock.
- **A "running" row is only a claim**: it carries its owner (boot id) and a lease. On
  startup, runs owned by an earlier boot are dead — Spring Batch leaves them
  `STARTED` forever, Airflow and River reclaim them from expired heartbeats.
- **Cancel has two tiers**: a cooperative stop at a batch boundary, then a hard kill of
  the *process* after a deadline (Celery's soft/hard time limits, Airflow's
  SIGTERM→SIGKILL, PostgreSQL's `pg_cancel_backend` vs `pg_terminate_backend`,
  Dataiku's killable worker processes). OHDSI WebAPI itself only cancels between
  queries.
- **DuckDB's `interrupt()` is not enough.** On 1.5.5 (our version) two issues report
  queries that never honour it, all threads parked (#24961, #26720 — fixed in 2.0,
  1.5.x no longer patched). An interrupt sent before the statement starts is lost
  (the flag is reset at query start). The move to 2.0 waits for a 2.0.x patch
  ([duckdb-2-plan.md](duckdb-2-plan.md)), so a killable process is the only sure stop.
- **Watchdog**: an adaptive deadline per batch, as TCP's retransmission timeout
  (RFC 6298): smoothed duration + 4 × its variation, with a floor and a cap.

## 2. Target design

### 2.1 The run

A new table `concept_runs`:

| Column | Role |
|---|---|
| `id`, `data_source_id`, `kind` (`stats` \| `extraction`), `scope_id` (workspace or mapping project) | what runs, for whom |
| `status` | `queued`, `running`, `pausing`, `paused`, `interrupted`, `done`, `failed`, `cancelled` |
| `requested` | what the user asked last (`pause`, `cancel`) — only the executor writes `status` |
| `spec` (JSON) | what the client compiled (§2.3), fixed for the run's life |
| `stage`, `cursor`, `done_weight`, `total_weight`, `done_count`, `total_count` | checkpoint and progress (weighted by rows) |
| `attempt`, `boot_id`, `lease_until` | owner and fencing: every write is `WHERE attempt = :mine` |
| `job_id` | the attempt's job, for the Jobs panel |
| `error`, `failed_concepts`, timestamps, `created_by` | |

Partial unique index on `(data_source_id, kind, scope_id) WHERE status IN
('queued','running','pausing')`: a second *start* returns the run already there.

Each **attempt** is one server job (entity = the database or the mapping project), so
the Jobs panel shows one row per run, with its %, and its Cancel = pause.

### 2.2 The loop (server)

1. **Counts** (stats run only, when asked): the existing unit job items and assemble
   SQL, now posted in the spec and run by the loop — no browser handover (decided
   2026-11-08: counts and statistics are one run).
2. **Fingerprint**, **ranking** (from the counted records, or the ranking SQL),
   **plan**: ranked ids written to `data_dir/runs/<id>/ranking.json` once. A resume
   never re-ranks.
3. **Batches**: fill the batch template with the batch's ids, run it in the worker
   (§2.4), assemble the profiles in Python, write them
   (`concept_profile_service.write`) and advance the cursor **in one transaction**.
   Extraction runs also append the CSV rows and update `source_extraction`.
4. Between batches: renew the lease, read `requested` → stop cleanly (`paused`).

### 2.3 Client compiles, server runs

The SQL builders (profiles, class relations: ~5k TS lines) stay in TypeScript, shared
with WASM. The client posts a small **spec** (kilobytes):
- fingerprint SQL; per dictionary the ranking SQL (or the counted relation) and ids SQL;
- per (dictionary, home table, sections): a **batch template** with an id placeholder
  (a small option in `batchScope`);
- extraction: the options and the page ordering;
- stats with counts: the count step items and assemble SQL.

Ported to Python, each with a **twin test on a shared golden fixture** (as
`dataset_ops`): `mergeTableCounts`, `planConceptWalk`, `packProfileBatches`,
`missingSections`, the result assembly (`readScalar`, `assembleProfileJson`,
`histogramFromRows`, cell counts, masking), `mergeProfile`/`filterProfile`, CSV rows.
The per-concept fallback of a failed batch becomes: split the batch, then record the
concept as failed.

### 2.4 Killable worker and watchdog

- The run's queries go to **one worker process per active run** (`spawn` context),
  which opens its own connection once (ATTACH once) and answers over a pipe. Never
  `fork`, never a shared `multiprocessing.Queue`, never `ProcessPoolExecutor`.
- **Pause/cancel ladder**: stop at the next batch boundary → `interrupt()` re-sent
  until acknowledged → after 10 s SIGTERM → 5 s later SIGKILL; the worker's
  `temp_directory` is its own, wiped at start. "Stopping…" thus has a deadline.
- **Watchdog**: deadline = clamp(SRTT + 4·RTTVAR, 30 s, 30 min) scaled by the batch's
  expected rows. Expired → kill, retry once with twice the deadline, then split the
  batch, then mark the concept failed and go on. Attempts are capped.
- Engines: the worker covers what DuckDB reads locally (Parquet folders, DuckDB and
  SQLite files, opened `READ_ONLY`). Remote engines (PostgreSQL, MySQL…) keep the
  in-process path, where `pg_cancel_backend`-style hooks already stop the query.
  To check first: a `.duckdb` file the API pool holds read-write cannot be opened by
  another process.

### 2.5 After a server restart

`reconcile_on_startup`: runs of an earlier boot → `interrupted`. They resume by
themselves (decided 2026-11-08) when their login can be resolved again (file databases, remembered logins);
otherwise they wait for the user (session-only login), and the page says why.

### 2.6 The page

- `GET /concept-runs?dataSourceId=&kind=&scopeId=` polled (1–2 s while active, with
  an ETag), and `POST` start / pause / resume / restart. No run state in the browser.
- One status line and the existing `RunSteps`; progress weighted by rows; "Stopping…"
  with its deadline; failed concepts listed.

## 3. Steps

| # | Step | Effort |
|---|---|---|
| 0 | Containment, done: the counts→statistics handover no longer flashes the menu; "Stopping…" aligned | — |
| 1 | `concept_runs` model + migration, state machine, single-flight index, lease/fencing, startup reconcile, routes; API tests | M |
| 2 | Python twins (ranking, packing, assembly, merge, CSV) + golden fixtures generated from the TS side | M |
| 3 | Worker process + ladder + watchdog; tests with a worker that hangs on purpose | M |
| 4 | Stats run on the server loop (counts → ranking → batches); Concepts tab observes it; delete reattach/handover code | M |
| 5 | Extraction run on the same loop; Source concepts tab observes it; `jobIds` leaves `SourceExtraction` (export twins) | M |
| 6 | Cleanup of what became dead (§4), docs (`architecture.md`, website doc), e2e journeys | S |

## 4. Becomes dead in server mode

`profile-jobs.ts`, `server-profile-jobs.ts`; in `extraction-runner.ts` the `jobs` /
`previousJobIds` / kept-jobs / `forgetStoppedJobs` / job-backed queries paths;
`isJobGoingOn`, `queryJobKeys`, `queryJobKeyRows`, `queryJobProgress` and the
server's `keys` route and `share_lane`; the reattach effects and `statsQueued` in the
two tabs; `use-concept-count` `left`/`leftJob` and the manifest's `job`/`asked`;
`SourceExtraction.jobIds`. `page-leaving.ts` and `run-registry.ts` stay (DQ, catalog).

## 5. Tests

- API: state machine, a second start returns the first run, lease expiry, reconcile
  after a fake restart, fencing (a stale attempt cannot write), pause at a batch
  boundary, the ladder against a worker that never answers, watchdog split.
- Twins: Python vs TypeScript on the same fixture rows.
- E2E (`long-runs`): reload at any moment — ranking included — shows the same run;
  pause ends within its deadline; a server restart mid-run resumes; one job per run.

## 6. Risks

- Twin drift between TS and Python assembly — guarded by the golden fixtures.
- `.duckdb` file opened by two processes (§2.4) — measure before step 3.
- SQLite as the app DB: one writer; lease renewals stay one short write per batch.
- A session-only database login cannot survive a restart: the run waits for the user.

## 7. Research note

Sources: Google AIP-151; microsoft/api-guidelines (Azure LRO); Spring Batch reference
(domain, advanced metadata); Kubernetes Jobs; OHDSI Achilles and the OHDSI forum on
killing Atlas jobs; Airflow task lifecycle; River maintenance services; Celery workers
and time limits; Temporal activity failure detection; PostgreSQL partial indexes and
admin functions; SQLite partial indexes; Kleppmann on fencing tokens; DuckDB issues
#24961, #26720, #15925 and duckdb-rs #860; DuckDB concurrency and temp-file docs;
Python `multiprocessing` and `concurrent.futures`; pebble; Dataiku processes; RFC 6298.

## 8. Status (2026-11-08)

Steps 1–6 are built; the as-built is `docs/architecture.md` § Concept runs. Left:

- To test by hand on a real warehouse (the planning README's *Test by hand*).
- Counting units and assemblies still run in the API process (they write the
  concept cache's files there): a unit ignoring its interrupt is let go of after
  `deferred.STOP_WAIT_SECONDS`, as before, not killed.
- An external database's batches run in the API process too (§2.4).
- The browser's count runner and its server routes (`units-job`, `assemble`) are
  gone; `profile-jobs.ts`, the query jobs' `keys` route and `shareLane` too.
