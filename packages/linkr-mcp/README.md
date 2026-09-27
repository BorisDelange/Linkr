# `@linkr/mcp`

The `linkr` MCP server: it drives a **running Linkr instance** through its REST API,
as one user. Agents run in an external client — LibreChat beside Linkr, Claude Code.

Plan: [`docs/planning/ai-agents-plan.md`](../../docs/planning/ai-agents-plan.md) §4.

## What it does

Drives a running server — what a user does in the app, bar what is kept out by design
(below): workspaces, projects and databases; cohorts; data quality; datasets, dashboards,
patient data and plugins; the IDE (scripts, runs, kernels, environments, jobs); concept
mapping; ETL pipelines and SQL collections; wiki, data catalogs and READMEs; git status.
It reuses the app's own logic (the cohort compiler `apps/web/src/lib/duckdb/cohort-query.ts`,
the concepts page's `concept-queries.ts`, the data-quality and catalog builders…) through
the `@/` alias, so the SQL it runs is the SQL the app runs.

Every call goes through the REST API with the user's credentials, so the server
re-checks every permission — an agent never exceeds the user it acts for. Tools carry
`readOnlyHint` / `destructiveHint` annotations, so a client can auto-approve reads.
Every request carries `X-Linkr-Client: mcp`: the server then refreshes the user's open
tabs and lists the change in the header's notification centre.

Configure it in `packages/linkr-mcp/.env` (gitignored; template `.env.example`):
`LINKR_API_URL` plus either `LINKR_TOKEN` (a personal API key `lnk_…`) or `LINKR_USERNAME` + `LINKR_PASSWORD`.
The repo's `.mcp.json` registers it for Claude Code sessions opened here.
Run it by hand with `npx tsx --tsconfig packages/linkr-mcp/tsconfig.json packages/linkr-mcp/src/live/server.ts`
— the explicit `--tsconfig` is what resolves the `@/` alias into `apps/web/src`.

**What the client sees.** By default ~30 common tools (`CORE_TOOLS` in `build.ts`:
context, exploration, cohorts, datasets, dashboards, scripts) plus four gateway tools —
about 6k tokens of definitions instead of ~40k for all ~230:

- `find_linkr_tools` — search every other tool by need (in English), or get tools by
  name: description, arguments as JSON Schema, and which run tool calls it. With no
  argument, the index of every tool by family. Its description lists the families.
- `run_linkr_read_tool` / `run_linkr_write_tool` / `run_linkr_delete_tool` — call a tool
  found that way; each only accepts tools of its kind and carries the matching
  annotation, so the client's approval still tells reads from writes from deletions.
  Arguments are validated against the tool's own schema.

The list never changes, so nothing is configured in the client: add the server, done.
`LINKR_MCP_TOOLSETS` exposes families directly on top of the core (`mapping`,
`lab,ide`…), or `all`: every tool, no gateway — what a client that loads tools on demand
wants (Claude Code: the repo's `.mcp.json` sets it).

**Out of reach by design**: permissions, roles, members and users; deleting a project or
a workspace; git commit / push; secrets (database passwords and logins, connection
details, API keys, git host tokens) — see `docs/planning/ai-agents-plan.md` §6.

### `context` — always direct

| Tool | Purpose |
|---|---|
| `list_projects`, `get_project_context` | projects; linked databases with their schema mapping in plain words; cohorts |
| `get_ui_context` | where the user is in their last-focused Linkr tab (project, page, open cohort / dashboard + tab / dataset) — the defaults behind "this", "here" |
| `search_docs`, `read_doc` | the user documentation (linkr.interhop.org): keyword search over the `docs-index.json` the website publishes at build (cached an hour; `LINKR_DOCS_INDEX` points elsewhere, e.g. a local website build; when the site is unreachable, falls back to the copy in `data/docs-index.json.gz`, refreshed with `npm run docs:snapshot`), then a page in full as Markdown |

### `workspace` — workspaces, projects, databases

| Tool | Purpose |
|---|---|
| `list_workspaces`, `get_workspace`, `create_workspace`, `update_workspace`, `list_organizations` | workspaces: what each holds (projects, databases, schema presets, mapping projects, wiki), README, organization, badges; create one (no delete) |
| `create_project`, `get_project_summary`, `update_project` | the New project dialog (entity id validated or derived from the name, lineage); the Summary page — status, version, badges, descriptions, README, notes, tasks (no delete) |
| `link_database_to_project`, `unlink_database_from_project` | a project's linked databases, ids and portable refs kept aligned as the app does |
| `list_databases`, `get_database`, `update_database` | the workspace's databases: status, kind, schema mapping, statistics, the projects linking them; name/description/alias/badges/README — never locations or logins |
| `list_schema_presets`, `set_database_schema`, `retest_database` | a preset's mapping on a database (update keeps overrides, switch drops them), then the Retest connection |
| `create_database` | an empty DuckDB from a preset's DDL, data already on the server (file or Parquet folder, read in place), or an external PostgreSQL/MySQL declared without any password — each user enters their own login in Linkr |

### `warehouse` — exploration, cohorts, concepts, derived databases

| Tool | Purpose |
|---|---|
| `describe_database`, `search_concepts`, `run_sql` | tables and columns; fuzzy concept search with record/patient counts; read-only SQL |
| `list_cohorts`, `get_cohort`, `create_cohort`, `update_cohort`, `delete_cohort` | criteria validated against the mapping, concept names filled in; or custom SQL |
| `preview_cohort_sql`, `run_cohort` | generated SQL; count + attrition (sample rows opt-in) |
| `freeze_cohort`, `unfreeze_cohort` | the app's Materialize: the server runs the full membership and stores it as the cohort's frozen list (what Patient data reads); project cohorts, not event level |
| `import_atlas_cohort` | a cohort from an OHDSI ATLAS definition (object or JSON string), with the app's converter; lists every ATLAS feature dropped and whether the criteria fit the database's mapping |
| `cohort_report` | the app's cohort report: a text summary for the model + the HTML report as an MCP-UI resource (`ui://`), rendered inline by LibreChat and never sent to the model |
| `list_concept_sets`, `get_concept_set` | the workspace's imported data dictionaries (read-only): resolved concept ids, `uniqueId`, long description with its Mapping Notes |
| `list_concept_lists`, `get_concept_list`, `create_concept_list`, `update_concept_list`, `delete_concept_list` | the project's hand-picked concept lists |
| `list_database_cohorts`, `plan_cohort_derivation` | a database's own cohorts; whether a cohort can be derived and what the copy does with each table |
| `derive_database_from_cohort` | the app's *Derive*: a new database (or SQL schema) restricted to a cohort — creates the managed target first, starts the server job, returns its `job_id` at once |
| `get_job_status`, `cancel_job` | a job's status, progress, log tail and, for a finished derivation, the database id to query |

### `dq` — data quality

| Tool | Purpose |
|---|---|
| `list_dq_rule_sets`, `get_dq_rule_set`, `create_dq_rule_set`, `update_dq_rule_set`, `delete_dq_rule_set` | data-quality rule sets (workspace-level, one database each): metadata, custom checks, last score, recent runs |
| `list_dq_checks` | every check a rule set runs — the app's generated ones (builtin: empty tables, per-column NULL rates; schema: mapping-aware consistency/plausibility) built with its own `data-quality-checks.ts`, plus custom SQL checks |
| `create_dq_check`, `update_dq_check`, `delete_dq_checks` | custom SQL checks (`violated_rows` / `total_rows`), validated like the editor and test-run on the database before saving |
| `run_dq_rule_set` | a scan (all checks or a subset): score, counts per category/severity, failing checks; recorded in the run history like the page (dry run opt-in) |
| `list_dq_runs`, `get_dq_run`, `delete_dq_runs` | run history, one run's results by status, deletion (`destructiveHint`) |

### `lab` — datasets, dashboards, patient data, pipeline, plugins

| Tool | Purpose |
|---|---|
| `list_datasets`, `describe_dataset`, `preview_dataset` | datasets, columns (ids used by widgets), per-column summaries, rows on request |
| `create_dataset_from_query` | a query's full result written server-side as a Parquet dataset — rows never transit through the agent |
| `rename_dataset_column`, `remove_dataset_columns`, `set_column_metadata` | column edits recorded in the dataset's edit history (undoable in Linkr); labels, descriptions, value labels |
| `duplicate_dataset`, `move_dataset`, `delete_dataset` | files in the project's datasets |
| `list_plugins`, `describe_plugin` | widget types, and one plugin's config fields derived from its manifest |
| `list_dashboards`, `describe_dashboard`, `create_dashboard`, `update_dashboard`, `delete_dashboard` | dashboards with their tabs, widgets and filters |
| `add_dashboard_filter`, `remove_dashboard_filter` | the filter sidebar: a dataset column, range or multi-select by type, optionally limited to tabs |
| `add_tab`, `rename_tab`, `add_widget`, `update_widget` | columns by name or id, unknown columns/fields refused, 48-column grid placement |
| `remove_widget`, `remove_tab` | `destructiveHint` — undoable from the notification centre |
| `create_dataset`, `create_dataset_folder` | an empty dataset from a column list (a manual collection's start, CSV header on disk); folders |
| `find_dataset_rows`, `list_column_values` | rows by filters/sort/page with their row numbers (the edit handle); a column's distinct values |
| `add_dataset_column`, `set_dataset_column_type`, `move_dataset_column` | column edits as ops in the edit history; a retype amends the column's own `addColumn` op when an edit added it, else sets `parseOptions.columnTypes` and re-reads the raw file |
| `set_dataset_cells`, `add_dataset_rows`, `remove_dataset_rows` | cell/row edits in the op log, values checked against the column type, one undoable action per call (`remove_*` destructive) |
| `get_dataset_edit_history`, `undo_dataset_edits` | the log grouped into actions; undo drops the last action(s), as Linkr's undo does |
| `set_dataset_import_options` | re-read the raw CSV/Excel with other delimiter/encoding/skip/header/sheet/NA tokens, or preview the result |
| `list_dataset_analyses`, `create_dataset_analysis`, `update_dataset_analysis`, `delete_dataset_analysis` | a dataset's analysis tabs: a lab plugin (built-in or workspace) with a checked config, or inline R/Python |
| `describe_pipeline`, `add_pipeline_node`, `update_pipeline_node`, `remove_pipeline_node`, `link_pipeline_nodes` | the project's Pipeline diagram (database/cohort/scripts/dataset/dashboard/group nodes and arrows), links checked against the project |
| `list_patient_plugins`, `describe_patient_plugin` | Patient data widget types: built-in manifests + the workspace's warehouse plugins |
| `list_patient_boards`, `describe_patient_board`, `create_patient_board`, `update_patient_board`, `duplicate_patient_board`, `delete_patient_board` | Patient data boards: database pointer, display settings, copies with tabs and widgets |
| `add_patient_tab`, `update_patient_tab`, `reorder_patient_tabs`, `remove_patient_tab` | a board's tabs (the last one is kept) |
| `add_patient_widget`, `update_patient_widget`, `duplicate_patient_widget`, `remove_patient_widget` | config checked against the manifest (concept ids, options, types); Timeline dataset mappings resolved name → id; custom SQL; move between tabs |
| `duplicate_dashboard`, `reorder_dashboard_tabs`, `move_widget`, `duplicate_widget`, `update_dashboard_display`, `set_dashboard_description` | lab dashboard actions beyond create/edit: copies (tab-scoped filters remapped), tab order, cross-tab moves, display settings, tab/widget descriptions |
| `list_user_plugins`, `get_user_plugin`, `create_user_plugin`, `update_user_plugin`, `delete_user_plugin` | workspace plugins as code: manifest + R/Python templates, checked as the app reads them (scope, languages ↔ templates, field types, `{{placeholders}}`), content hash restamped; built-ins read-only |

### `ide` — scripts, runs, kernels, environments, jobs

| Tool | Purpose |
|---|---|
| `list_scripts`, `read_script`, `write_script`, `move_script`, `delete_script` | the project's IDE scripts, shown live in the user's IDE |
| `run_code`, `run_script` | R or Python in the project's server kernel (session `default`, shared with the IDE); stdout, stderr, returned table; figures as a `ui://` resource |
| `list_sessions`, `create_session`, `delete_session` | the user's kernel sessions (isolated R / Python namespaces; `default` is the IDE's) with live-kernel state (idle / busy, memory) |
| `restart_kernel`, `interrupt_kernel` | a session's kernel: restart (variables lost, `destructiveHint`; needed after a build) or Stop the running code |
| `run_as_job`, `get_job_output` | a script or code run as a background job (fresh process, jobs panel), returns the `job_id`; then its log, table and figures (`ui://`) |
| `list_jobs`, `clear_finished_jobs` | the jobs panel of a project (runs, builds, package ops) or a workspace (derivations); clearing finished ones is `destructiveHint` |
| `describe_environment` | the project's managed Python / R environment: status, declared packages, last update check, install options (URL credentials masked), sessions on a stale build |
| `install_packages`, `remove_package`, `update_packages`, `install_package_preset`, `check_package_updates`, `build_environment` | the Environments panel: spec re-locked by the server, optional build as a job (`job_id`) |
| `set_environment_options` | package repository / index for the environment (R `repos`, `method`; Python `index_url`, `trusted_host`); URLs with credentials refused |
| `list_ide_connections` | databases a project's scripts can query: linked databases (`database_id` for `run_code`) and the IDE's custom connections, never credentials |

### `mapping` — concept mapping

| Tool | Purpose |
|---|---|
| `list_mapping_projects`, `get_mapping_project` | concept-mapping projects: progress, vocabulary database, suggestions file, source categories |
| `list_source_concepts`, `get_source_concept` | source concepts by status / category / name / has-suggestions, with their metadata (`info_json`), existing mappings and suggestions; a database project not yet extracted is read straight from its dictionaries (no counts, no metadata) |
| `search_vocabulary`, `get_vocabulary_concept` | OMOP targets in the project's vocabulary database (name, synonyms, filters, a concept set's resolved concepts); relationships, ancestors, descendants |
| `add_ai_suggestions` | `ai/<model>` rows appended to the project's scores file — shown in the Suggestions panel for review; unknown / non-standard targets refused, existing rows kept |
| `create_mappings` | mappings (status unchecked) for picks the user confirmed; already-mapped sources skipped; project stats refreshed |
| `remove_ai_suggestions` | withdraw a model's `ai/<model>` rows, all or for some source concepts (`destructiveHint`) |
| `find_sources_for_targets` | reverse lookup: the source concepts suggestions link to given targets or a concept set's resolved concepts |
| `create_mapping_project`, `update_mapping_project` | a mapping project from a database's dictionaries (or empty, for a file imported in Linkr), with badges, status, vocabulary database; metadata edits |
| `delete_mapping_project` | the project with its mappings (`destructiveHint`) |
| `list_mappings` | a project's mappings by effective status (incl. disputed), words, codes, target, author, the user's votes; votes, comments, lock |
| `review_mappings`, `update_mapping` | the app's review votes (approved / rejected / flagged / clear, own mappings not approvable), equivalence change (refused once locked), signed comments |
| `delete_mappings` | reviewed / commented ones only with `include_locked` (`destructiveHint`) |
| `list_source_concept_id_ranges`, `set_source_concept_id_range`, `assign_source_concept_ids`, `get_source_concept_ids` | the workspace's custom concept id registry (2 000 000 000+): one range per badge, the app's Assign (stable ids, cursor saved per chunk), lookups |

### `etl` — ETL pipelines, SQL collections

| Tool | Purpose |
|---|---|
| `list_etl_pipelines`, `get_etl_pipeline`, `create_etl_pipeline`, `update_etl_pipeline`, `delete_etl_pipeline` | ETL pipelines (workspace SQL scripts building a target database from a source): source / target / mapping-project vocab, scripts in run order with their last outcome |
| `read_etl_file`, `write_etl_file`, `move_etl_file`, `delete_etl_file` | a pipeline's files (scripts, notes, `mapping/*.csv` exports); new scripts appended to the run order; versioning marks follow moves |
| `update_etl_script`, `reorder_etl_scripts` | per-script disabled flag and database override; run order as a full list or sorted by name |
| `run_etl_pipeline` | the app's Run: enabled scripts in order (or the ones given), `source.`/`target.`/`vocab.` resolved, on the writable target through the ETL endpoint, stops at the first error, recorded in the run history |
| `list_etl_runs`, `get_etl_run` | past runs; one run's per-script status, duration, rows or error |
| `list_sql_collections`, `get_sql_collection`, `create_sql_collection`, `update_sql_collection`, `delete_sql_collection` | SQL script collections (reusable queries in a workspace, with a default database) |
| `read_sql_collection_file`, `write_sql_collection_file`, `move_sql_collection_file`, `delete_sql_collection_file` | a collection's scripts and folders |
| `run_sql_collection_script` | one collection script on its database, read-only as the editor runs it; last statement's rows |

### `wiki` — wiki, data catalogs, READMEs

| Tool | Purpose |
|---|---|
| `list_wiki_pages`, `search_wiki_pages`, `get_wiki_page` | the workspace wiki: page tree, search with snippets, one page's Markdown (per language) with its path and attachments; by `workspace_id` or `project_uid` |
| `create_wiki_page`, `update_wiki_page`, `move_wiki_page`, `delete_wiki_page` | pages as the wiki store writes them (slug, sort order, author); move renumbers siblings and refuses cycles; delete takes the sub-pages and attachments (`destructiveHint`) |
| `list_data_catalogs`, `get_data_catalog`, `create_data_catalog`, `update_data_catalog`, `delete_data_catalog` | anonymized aggregate catalogs of a database: dimensions, age brackets, threshold, category columns, period table — with the Configuration tab's rules |
| `compute_data_catalog`, `get_data_catalog_results`, `reset_data_catalog_results` | the app's resumable computation (`lib/duckdb/catalog-batch.ts`) through the server query route, results in the shared results cache; time-budgeted, resumes on the next call; sub-threshold counts masked |
| `get_readme`, `set_readme` | the Markdown README of a workspace, database, mapping project, SQL collection, ETL pipeline, DQ rule set, data catalog or plugin (one language, others kept) |

### `git` — versioning, read-only

| Tool | Purpose |
|---|---|
| `get_git_status`, `get_git_diff`, `get_git_sync_state`, `list_git_branches` | read-only git versioning of a project, workspace, mapping project or workspace entity: pending files vs the remote branch, one file's line diff, behind / diverged, branches — commit, push and pull stay in Linkr |

Code: `server.ts` / `http.ts` (entries) · `build.ts` (toolsets, core list) · `gateway.ts` / `tools-gateway.ts`
(catalogue, find + run) · `shared.ts` · `tools-context.ts` (UI context, projects) ·
`tools-workspace.ts` / `tools-databases.ts` / `workspace-rest.ts` (workspaces, projects, databases) ·
`tools-warehouse.ts` (exploration, cohorts, report) · `tools-cohorts-extra.ts` (freeze, ATLAS import) · `tools-concepts.ts` ·
`tools-derive.ts` (derived databases, jobs) · `tools-dq.ts` (data quality) ·
`tools-lab.ts` (datasets, plugins, dashboards) · `tools-lab-extra.ts` (dataset editing, analyses, pipeline, patient
boards, dashboard extras, workspace plugins) · `tools-ide.ts` (scripts, runs) · `tools-runtime.ts` (kernel sessions,
jobs, environments, IDE connections) · `tools-mapping.ts` (concept mapping) · `tools-mapping-extra.ts` (mapping
projects, reviews, source concept ids) · `tools-etl.ts` (ETL pipelines, SQL collections) · `tools-wiki.ts` (wiki,
data catalogs, READMEs) · `tools-git.ts` (git, read-only) · `tools-docs.ts` (documentation) · pure helpers
`cohorts.ts`, `cohorts-extra.ts`, `concepts.ts`, `derive.ts`, `docs.ts`, `dq.ts`, `etl.ts`, `gateway.ts`, `git.ts`, `lab.ts`,
`lab-extra.ts`, `ide.ts`, `mapping.ts`, `mapping-extra.ts`, `plugins.ts`, `report.ts`, `runtime.ts`, `wiki.ts`,
`workspace.ts` (tested).

## Skills

`skills/` holds the procedures agents follow with these tools, in the open Agent Skills
format (any model, any client that loads skills). `concept-mapping` maps local codes to
OMOP concepts through the mapping tools; it is versioned for citation (`metadata.version`,
`CHANGELOG.md`). `npm run skill:pack` builds `dist/concept-mapping.zip` for LibreChat's
skill import; Claude Code reads it through the `.claude/skills/concept-mapping` link.
Setup: [`FORKING.md`](../../FORKING.md).

## Run it for LibreChat (HTTP)

```bash
npm run dev:mcp          # from the repo root; = cd packages/linkr-mcp && npm run start:http
                         # → http://127.0.0.1:3940/mcp
```

`npm run dev:all` starts it too, beside web and api, pointed at the local API
(`LINKR_API_URL` from the environment wins over `.env`) — see `scripts/dev-all.mjs`.

Each client authenticates with its **own Linkr API key** (Profile → API keys in Linkr,
`lnk_…`), sent as `Authorization: Bearer <key>` or `X-API-Key`; the tools then act as
that user. The key is checked against Linkr and the result cached a minute, so a
revoked key stops working within a minute. Only `LINKR_API_URL` is needed in `.env`.
In LibreChat: transport *Streamable HTTPS*, auth *API key*, header format *Bearer*,
**"each user provides their own key"** ticked, and the host listed in `librechat.yaml`
`mcpSettings.allowedDomains`.

With Docker, `docker/docker-compose.yml` runs it as the `mcp` service
(`docker/Dockerfile.mcp`: the HTTP entry bundled by esbuild into one file, next to
the files it reads at runtime — docs snapshot, app locales, analysis manifests),
on port 3940 and pointed at the `api` service. Release tags publish it as
`interhop/linkr:mcp-<version>`.

Optional single-user mode: set `LINKR_MCP_KEY` (≥ 24 characters) and a request carrying
it acts with the `.env` credentials. `LINKR_MCP_HOST` / `LINKR_MCP_PORT` override the
address (`0.0.0.0` when LibreChat runs in Docker, then reached at
`host.docker.internal`).

## Notes

- **stdout is the JSON-RPC channel** — never write to it. Diagnostics go to stderr.
- Input schemas are declared as plain **JSON Schema** through the SDK's `fromJsonSchema`.

## Testing

```bash
npx vitest run
npx tsc --noEmit
```
