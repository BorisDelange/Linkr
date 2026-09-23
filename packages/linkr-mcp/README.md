# `@linkr/mcp`

Two MCP servers, two targets:

| Server | Entry | Acts on |
|---|---|---|
| **`linkr`** | `src/live/server.ts` | a **running Linkr instance**, through its REST API, as one user |
| `linkr-files` | `src/server.ts` | entity trees **on disk** — to be removed once `linkr` covers its uses |

Plan: [`docs/planning/ai-agents-plan.md`](../../docs/planning/ai-agents-plan.md) §4.

## `linkr` — live

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
The repo's `.mcp.json` registers both servers for Claude Code sessions opened here.
Run it by hand with `npx tsx --tsconfig packages/linkr-mcp/tsconfig.json packages/linkr-mcp/src/live/server.ts`
— the explicit `--tsconfig` is what resolves the `@/` alias into `apps/web/src`.

| Tool | Purpose |
|---|---|
| `get_ui_context` | where the user is in their last-focused Linkr tab (project, page, open cohort / dashboard + tab / dataset) — the defaults behind "this", "here" |
| `list_projects`, `get_project_context` | projects; linked databases with their schema mapping in plain words; cohorts |
| `describe_database`, `search_concepts`, `run_sql` | tables and columns; fuzzy concept search with record/patient counts; read-only SQL |
| `list_cohorts`, `get_cohort`, `create_cohort`, `update_cohort` | criteria validated against the mapping, concept names filled in; or custom SQL |
| `preview_cohort_sql`, `run_cohort` | generated SQL; count + attrition (sample rows opt-in) |
| `list_datasets`, `describe_dataset`, `preview_dataset` | datasets, columns (ids used by widgets), per-column summaries, rows on request |
| `create_dataset_from_query` | a query's full result written server-side as a Parquet dataset — rows never transit through the agent |
| `list_plugins`, `describe_plugin` | widget types, and one plugin's config fields derived from its manifest |
| `list_dashboards`, `describe_dashboard`, `create_dashboard` | dashboards with their tabs and widgets |
| `add_tab`, `rename_tab`, `add_widget`, `update_widget` | columns by name or id, unknown columns/fields refused, 48-column grid placement |
| `remove_widget`, `remove_tab` | `destructiveHint` — undoable from the notification centre |

Code: `server.ts` (bootstrap) · `shared.ts` · `tools-context.ts` · `tools-warehouse.ts`
(projects, databases, cohorts) · `tools-lab.ts` (datasets, plugins, dashboards) · pure
helpers `cohorts.ts`, `lab.ts`, `plugins.ts` (tested).

## `linkr-files` — entity trees on disk

Lets any agent author Linkr content outside Linkr: write a project tree, edit it, and
have every change validated against the real format.

It contains no format knowledge. Every tool parses its arguments, calls into
[`@linkr/format`](../linkr-format), and reports what came back. Design:
[`docs/architecture.md`](../../docs/architecture.md) § Format package & MCP authoring.

It writes **files**, never to a running Linkr instance — so it works offline, and it
produces exactly the tree shape the `linkr-public-content` repos use, which the normal
import path reads with no special-casing.

## Register it with Claude Code

```bash
claude mcp add linkr-files -- npx tsx /absolute/path/to/packages/linkr-mcp/src/server.ts
```

Or in `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "linkr-files": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/packages/linkr-mcp/src/server.ts"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `write_project` | Create a whole tree from a spec: metadata, datasets (from CSV text), dashboards with tabs and widgets, IDE scripts. Validates what it wrote. |
| `validate_entity` | Report missing files, broken references, unknown columns, legacy formats. Detects the kind (project / SQL collection / ETL pipeline / schema preset) from the tree. |
| `describe_tree` | What a tree contains, **with the real ids and keys** — call before editing. |
| `describe_entity_schema` | Fields of a spec, from the code rather than from memory. |
| `add_dashboard_tab` | Add a tab to an existing dashboard. |
| `add_widget` | Add a widget to a tab. Column **names** in the config are resolved to ids. |
| `add_script` | Add a `.py`/`.r`/`.sql`/`.md` file and register it in `scripts/_tree.json`. |

Spec-first by design: `write_project` takes a full spec in one call, because a tool per
action costs a round trip each and re-sends every tool definition. The granular tools
exist for editing a tree that already exists, where re-emitting the whole spec would be
worse.

## The loop it is built around

Every mutating tool re-validates and says whether the tree still holds, and every
rejection names the valid alternatives:

```
> add_widget(tabKey: "overview/ghost", …)
  Unknown tab "overview/ghost". Known: overview/demographics, overview/outcomes.

> add_widget(layout: {x: 40, w: 24, …})
  Added widget "X" with key …
  1 error(s) now in the tree:
  ERROR dashboards/overview.json/widgets/1/layout
      [layout-out-of-grid] Widget spans past the grid: x=40 + w=24 > 48.
```

That is what lets an agent correct itself without reading this repo.

## Security

This server **cannot reach a Linkr instance**, so it cannot bypass its accounts or
permissions. It has no network access, no `child_process`, and uses only `fs`/`path`.
It writes files on the author's own machine; those files enter an instance through the
normal — authenticated, permission-checked — import path. Someone who can import a
project could already hand-write the same ZIP.

Talking to a running instance's API is deliberately out of scope. If that is ever added,
it must authenticate **as the user** and carry their permissions.

The one trust boundary that does exist: the caller is a model acting on text it was
given, so caller-supplied **paths are untrusted**. Every write resolves through
`resolveInside()`, which refuses anything landing outside the project root — a
directory-traversal hole found by probing this server over real JSON-RPC, now covered by
tests. Full reasoning: the plan's §5b.

## Notes

- **stdout is the JSON-RPC channel** — never write to it. Diagnostics go to stderr.
- Input schemas are declared as plain **JSON Schema** through the SDK's `fromJsonSchema`.
  zod arrives as a transitive dependency of the SDK but is not used here, and
  `@linkr/format` stays dependency-free so it never lands in the browser bundle.

## Testing

```bash
npx vitest run
npx tsc --noEmit
```
