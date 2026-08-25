# `@linkr/mcp`

An MCP server that lets any agent — Claude Code, OpenCode, Cursor, Codex — **author
Linkr content outside Linkr**: write a project tree, edit it, and have every change
validated against the real format.

It contains no format knowledge. Every tool parses its arguments, calls into
[`@linkr/format`](../linkr-format), and reports what came back. Design:
[`docs/planning/mcp-authoring-plan.md`](../../docs/planning/mcp-authoring-plan.md).

It writes **files**, never to a running Linkr instance — so it works offline, and it
produces exactly the tree shape the `linkr-public-content` repos use, which the normal
import path reads with no special-casing.

## Register it with Claude Code

```bash
claude mcp add linkr -- npx tsx /absolute/path/to/packages/linkr-mcp/src/server.ts
```

Or in `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "linkr": {
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
