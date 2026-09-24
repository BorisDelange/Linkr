# `@linkr/mcp`

The `linkr` MCP server: it drives a **running Linkr instance** through its REST API,
as one user. Agents run in an external client — LibreChat beside Linkr, Claude Code.

Plan: [`docs/planning/ai-agents-plan.md`](../../docs/planning/ai-agents-plan.md) §4.

## What it does

Drives a running server: projects, databases (schema, concepts, read-only SQL) and
cohorts (create, edit criteria or custom SQL, run with attrition). It reuses the app's
own query builders (`apps/web/src/lib/duckdb/cohort-query.ts`, the concepts page's
`concept-queries.ts`) through the `@/` alias, so the SQL it runs is the SQL the app runs.

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

| Tool | Purpose |
|---|---|
| `get_ui_context` | where the user is in their last-focused Linkr tab (project, page, open cohort / dashboard + tab / dataset) — the defaults behind "this", "here" |
| `list_projects`, `get_project_context` | projects; linked databases with their schema mapping in plain words; cohorts |
| `describe_database`, `search_concepts`, `run_sql` | tables and columns; fuzzy concept search with record/patient counts; read-only SQL |
| `list_cohorts`, `get_cohort`, `create_cohort`, `update_cohort`, `delete_cohort` | criteria validated against the mapping, concept names filled in; or custom SQL |
| `preview_cohort_sql`, `run_cohort` | generated SQL; count + attrition (sample rows opt-in) |
| `freeze_cohort`, `unfreeze_cohort` | the app's Materialize: the server runs the full membership and stores it as the cohort's frozen list (what Patient data reads); project cohorts, not event level |
| `import_atlas_cohort` | a cohort from an OHDSI ATLAS definition (object or JSON string), with the app's converter; lists every ATLAS feature dropped and whether the criteria fit the database's mapping |
| `cohort_report` | the app's cohort report: a text summary for the model + the HTML report as an MCP-UI resource (`ui://`), rendered inline by LibreChat and never sent to the model |
| `list_concept_sets`, `get_concept_set` | the workspace's imported data dictionaries (read-only): resolved concept ids, `uniqueId`, long description with its Mapping Notes |
| `list_concept_lists`, `get_concept_list`, `create_concept_list`, `update_concept_list`, `delete_concept_list` | the project's hand-picked concept lists |
| `list_datasets`, `describe_dataset`, `preview_dataset` | datasets, columns (ids used by widgets), per-column summaries, rows on request |
| `create_dataset_from_query` | a query's full result written server-side as a Parquet dataset — rows never transit through the agent |
| `rename_dataset_column`, `remove_dataset_columns`, `set_column_metadata` | column edits recorded in the dataset's edit history (undoable in Linkr); labels, descriptions, value labels |
| `duplicate_dataset`, `move_dataset`, `delete_dataset` | files in the project's datasets |
| `list_plugins`, `describe_plugin` | widget types, and one plugin's config fields derived from its manifest |
| `list_dashboards`, `describe_dashboard`, `create_dashboard`, `update_dashboard`, `delete_dashboard` | dashboards with their tabs, widgets and filters |
| `add_dashboard_filter`, `remove_dashboard_filter` | the filter sidebar: a dataset column, range or multi-select by type, optionally limited to tabs |
| `add_tab`, `rename_tab`, `add_widget`, `update_widget` | columns by name or id, unknown columns/fields refused, 48-column grid placement |
| `remove_widget`, `remove_tab` | `destructiveHint` — undoable from the notification centre |
| `list_scripts`, `read_script`, `write_script`, `move_script`, `delete_script` | the project's IDE scripts, shown live in the user's IDE |
| `run_code`, `run_script` | R or Python in the project's server kernel (session `default`, shared with the IDE); stdout, stderr, returned table; figures as a `ui://` resource |
| `list_mapping_projects`, `get_mapping_project` | concept-mapping projects: progress, vocabulary database, suggestions file, source categories |
| `list_source_concepts`, `get_source_concept` | source concepts by status / category / name / has-suggestions, with their metadata (`info_json`), existing mappings and suggestions; a database project not yet extracted is read straight from its dictionaries (no counts, no metadata) |
| `search_vocabulary`, `get_vocabulary_concept` | OMOP targets in the project's vocabulary database (name, synonyms, filters, a concept set's resolved concepts); relationships, ancestors, descendants |
| `add_ai_suggestions` | `ai/<model>` rows appended to the project's scores file — shown in the Suggestions panel for review; unknown / non-standard targets refused, existing rows kept |
| `create_mappings` | mappings (status unchecked) for picks the user confirmed; already-mapped sources skipped; project stats refreshed |
| `remove_ai_suggestions` | withdraw a model's `ai/<model>` rows, all or for some source concepts (`destructiveHint`) |
| `find_sources_for_targets` | reverse lookup: the source concepts suggestions link to given targets or a concept set's resolved concepts |
| `search_docs`, `read_doc` | the user documentation (linkr.interhop.org): keyword search over the `docs-index.json` the website publishes at build (cached an hour; `LINKR_DOCS_INDEX` points elsewhere, e.g. a local website build), then a page in full as Markdown |

Code: `server.ts` / `http.ts` (entries) · `build.ts` · `shared.ts` · `tools-context.ts` ·
`tools-warehouse.ts` (projects, databases, cohorts, report) · `tools-cohorts-extra.ts` (freeze, ATLAS import) · `tools-concepts.ts` ·
`tools-lab.ts` (datasets, plugins, dashboards) · `tools-ide.ts` (scripts, runs) · `tools-mapping.ts`
(concept mapping) · `tools-docs.ts` (documentation) · pure helpers `cohorts.ts`, `cohorts-extra.ts`, `concepts.ts`,
`docs.ts`, `lab.ts`, `ide.ts`, `mapping.ts`, `report.ts`,
`plugins.ts` (tested).

## Skills

`skills/` holds the procedures agents follow with these tools, in the open Agent Skills
format (any model, any client that loads skills). `concept-mapping` maps local codes to
OMOP concepts through the mapping tools; it is versioned for citation (`metadata.version`,
`CHANGELOG.md`). `npm run skill:pack` builds `dist/concept-mapping.zip` for LibreChat's
skill import; Claude Code reads it through the `.claude/skills/concept-mapping` link.
Setup: [`FORKING.md`](../../FORKING.md).

## Run it for LibreChat (HTTP)

```bash
cd packages/linkr-mcp && npm run start:http   # http://127.0.0.1:3940/mcp
```

Each client authenticates with its **own Linkr API key** (Profile → API keys in Linkr,
`lnk_…`), sent as `Authorization: Bearer <key>` or `X-API-Key`; the tools then act as
that user. The key is checked against Linkr and the result cached a minute, so a
revoked key stops working within a minute. Only `LINKR_API_URL` is needed in `.env`.
In LibreChat: transport *Streamable HTTPS*, auth *API key*, header format *Bearer*,
**"each user provides their own key"** ticked, and the host listed in `librechat.yaml`
`mcpSettings.allowedDomains`.

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
