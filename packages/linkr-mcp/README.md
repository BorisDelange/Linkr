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
`LINKR_API_URL` plus either `LINKR_TOKEN` or `LINKR_USERNAME` + `LINKR_PASSWORD`.
The repo's `.mcp.json` registers it for Claude Code sessions opened here.
Run it by hand with `npx tsx --tsconfig packages/linkr-mcp/tsconfig.json packages/linkr-mcp/src/live/server.ts`
— the explicit `--tsconfig` is what resolves the `@/` alias into `apps/web/src`.

| Tool | Purpose |
|---|---|
| `get_ui_context` | where the user is in their last-focused Linkr tab (project, page, open cohort / dashboard + tab / dataset) — the defaults behind "this", "here" |
| `list_projects`, `get_project_context` | projects; linked databases with their schema mapping in plain words; cohorts |
| `describe_database`, `search_concepts`, `run_sql` | tables and columns; fuzzy concept search with record/patient counts; read-only SQL |
| `list_cohorts`, `get_cohort`, `create_cohort`, `update_cohort` | criteria validated against the mapping, concept names filled in; or custom SQL |
| `preview_cohort_sql`, `run_cohort` | generated SQL; count + attrition (sample rows opt-in) |
| `cohort_report` | the app's cohort report: a text summary for the model + the HTML report as an MCP-UI resource (`ui://`), rendered inline by LibreChat and never sent to the model |
| `list_datasets`, `describe_dataset`, `preview_dataset` | datasets, columns (ids used by widgets), per-column summaries, rows on request |
| `create_dataset_from_query` | a query's full result written server-side as a Parquet dataset — rows never transit through the agent |
| `list_plugins`, `describe_plugin` | widget types, and one plugin's config fields derived from its manifest |
| `list_dashboards`, `describe_dashboard`, `create_dashboard` | dashboards with their tabs and widgets |
| `add_tab`, `rename_tab`, `add_widget`, `update_widget` | columns by name or id, unknown columns/fields refused, 48-column grid placement |
| `remove_widget`, `remove_tab` | `destructiveHint` — undoable from the notification centre |

Code: `server.ts` (bootstrap) · `shared.ts` · `tools-context.ts` · `tools-warehouse.ts`
(projects, databases, cohorts) · `tools-lab.ts` (datasets, plugins, dashboards) · pure
helpers `cohorts.ts`, `lab.ts`, `plugins.ts` (tested).

## Run it for LibreChat (HTTP)

```bash
cd packages/linkr-mcp && npm run start:http   # http://127.0.0.1:3940/mcp
```

Streamable HTTP, guarded by `LINKR_MCP_KEY` (≥ 24 characters, in `.env`), sent as
`Authorization: Bearer <key>` or `X-API-Key`. `LINKR_MCP_HOST` / `LINKR_MCP_PORT`
override the address (`0.0.0.0` when LibreChat runs in Docker, then reached at
`host.docker.internal`). In LibreChat: transport *Streamable HTTPS*, auth *API key*,
header format *Bearer*, and the host listed in `librechat.yaml`
`mcpSettings.allowedDomains`.

## Notes

- **stdout is the JSON-RPC channel** — never write to it. Diagnostics go to stderr.
- Input schemas are declared as plain **JSON Schema** through the SDK's `fromJsonSchema`.

## Testing

```bash
npx vitest run
npx tsc --noEmit
```
