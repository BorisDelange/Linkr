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
| `write_project` | create a whole project tree (`format: "zip"` for the import dialog) |
| `write_entity` | create a standalone entity (SQL collection, ETL pipeline, DQ rule set, data catalog, mapping project, schema preset) |
| `describe_tree` | what an existing tree holds, with its real ids and keys |
| `validate_entity` | check any tree; the kind is detected. Run after any change |
| `add_dashboard_tab`, `add_widget`, `add_script` | incremental edits |

Not registered? `claude mcp add linkr -- npx tsx <repo>/packages/linkr-mcp/src/server.ts`

## Elements

Read the reference for what you are building — it covers what the element is for and
the mistakes worth avoiding, **not** its field list (that is `describe_entity_schema`).

| Element | Reference | Buildable today |
|---|---|---|
| Project (metadata, README, tasks) | `references/project.md` | ✅ `write_project` |
| Dataset (CSV → table) | `references/dataset.md` | ✅ in a project |
| Dashboard (tabs, widgets, filters) | `references/dashboard.md` | ✅ in a project |
| IDE script (`.py`/`.r`/`.sql`/`.md`) | `references/script.md` | ✅ in a project |
| SQL collection / ETL pipeline (`.sql` trees) | `references/standalone-entities.md` | ✅ `write_entity` |
| DQ rule set (quality checks) | `references/standalone-entities.md` | ✅ `write_entity` |
| Data catalog | `references/standalone-entities.md` | ✅ `write_entity` |
| Concept-mapping project | `references/standalone-entities.md` | ✅ `write_entity` |
| Schema preset (how to read a database) | `references/standalone-entities.md` | ✅ `write_entity` |
| Plugin (widget code + manifest) | `references/plugin.md` | ⚠️ files by hand |
| Cohort (inside a project) | `references/standalone-entities.md` | ⚠️ validate only |
| Patient data view | — | ❌ computed live |

Everything Linkr can export is covered above. The **six** ✅ `write_entity` kinds live in
their **own** folder or repo (one repo per entity, as in `linkr-public-content`); a
project holds its own datasets, dashboards and scripts and is written with
`write_project`.

⚠️ A **plugin** ships as code in `packages/default-plugins/`, so the MCP does not write
it — `references/plugin.md` has the procedure. A **cohort** belongs to a project and
compiles to SQL, so a wrong one returns a different population rather than failing; build
it in the app. Say so rather than hand-rolling either one's JSON.

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
