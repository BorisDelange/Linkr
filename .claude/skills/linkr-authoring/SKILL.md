---
name: linkr-authoring
description: Author or edit Linkr content outside the app — a project, dashboard, dataset, plugin, script — as a validated entity tree, using the linkr MCP server. Use when the user wants to build a demo project, seed content for a portal, add a plugin, or fix an entity tree that does not import cleanly.
argument-hint: [what to build]
---

# Authoring Linkr content

You produce **files** — an entity tree the app imports — never app source code. The
format is owned by `packages/linkr-format` and exposed through the `linkr` MCP server;
your job is the *content*: what the project is about, what the data looks like, which
indicators matter.

## The loop

1. **Ask what is needed** — domain, indicators, row count, languages (names are
   `{en, fr}`: fill both).
2. **Read the schema** — `describe_entity_schema(kind)`. It comes from the code, so
   prefer it over anything remembered, including the references in this skill.
3. **Author the content** — the CSV rows, the script bodies, the widget choices. This
   is the part no tool can do for you; see `references/` for what each element is for.
4. **Write** — `write_project` for a new tree, `add_*` for an edit.
5. **Fix what it reports** — every issue names a file, a JSON Pointer and the valid
   alternatives. Repeat until clean.

Never hand-write `_tree.json`, column ids, or content keys. If a tool cannot express
what you need, say so — do not work around it by editing the JSON directly, because the
next validation will disagree with you.

## MCP tools

| Tool | Use |
|---|---|
| `describe_entity_schema` | fields of a spec — **read before writing** |
| `write_project` | create a whole tree (`format: "zip"` for the import dialog) |
| `describe_tree` | what an existing tree holds, with its real ids and keys |
| `validate_project` | check a tree; run after any change |
| `add_dashboard_tab`, `add_widget`, `add_script` | incremental edits |

Not registered? `claude mcp add linkr -- npx tsx <repo>/packages/linkr-mcp/src/server.ts`

## Elements

Read the reference for what you are building — it covers what the element is for and
the mistakes worth avoiding, **not** its field list (that is `describe_entity_schema`).

| Element | Reference | Buildable today |
|---|---|---|
| Project (metadata, README, tasks) | `references/project.md` | ✅ |
| Dataset (CSV → table) | `references/dataset.md` | ✅ |
| Dashboard (tabs, widgets, filters) | `references/dashboard.md` | ✅ |
| IDE script (`.py`/`.r`/`.sql`/`.md`) | `references/script.md` | ✅ |
| Plugin (widget code + manifest) | `references/plugin.md` | ⚠️ files by hand |
| Cohort, ETL pipeline, mapping project, SQL collection, schema preset, DQ rule set | — | ❌ not yet |

⚠️ A plugin lives in `packages/default-plugins/`, not in a project tree, so the MCP does
not write it — `references/plugin.md` carries the full procedure. ❌ elements have no
serializer yet; say so rather than hand-rolling their JSON.

## What is NOT authorable

**Patient Data pages** cannot be seeded. They are computed live by SQL against a
connected OMOP database; no payload in a tree can populate them. If asked, say so and
offer an OMOP-shaped dataset instead.

## Handing off

A **folder** is the default: it diffs in git and is what the portal and the
`linkr-public-content` repos consume. Use `format: "zip"` when the user will drag it
into *Import a project*.

Tell the user what you built, and state the validation result plainly — including
warnings you chose not to fix, and why.
