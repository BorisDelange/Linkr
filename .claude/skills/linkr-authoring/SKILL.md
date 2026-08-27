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

### Editing a tree that already exists

**Read it through the server, not with your own file tools.** `describe_tree` gives the
ids, every widget's `config` and grid position, and which tabs or widgets a filter is
scoped to; `read_file` returns any file verbatim. Between them you should never need to
open a file yourself.

The reason is not tidiness. **Ids in a Linkr tree are derived, not stored**: a column id
is `col_<slug of name>`, and a widget's key is `<tab>/<slug of name>@<y>,<x>`. Edit one by
hand and the app re-derives a different one on import — the entity comes back as a
*different* entity, orphaning every filter, layout and reference that pointed at it. That
is a bug this project has already paid for once.

| To… | Use | |
|---|---|---|
| see ids, configs, layouts, filter scopes | `describe_tree` | ✅ |
| read a script / SQL / any file | `read_file` | ✅ |
| add a tab, widget or script | `add_dashboard_tab`, `add_widget`, `add_script` | ✅ |
| change a widget's config, dataset or plugin | `update_widget` | ✅ |
| rename a widget or a tab | `rename_widget`, `rename_dashboard_tab` | ✅ |
| move or resize a widget | `move_widget` | ✅ |
| delete a widget or a tab | `remove_widget`, `remove_dashboard_tab` | ✅ |
| overwrite a script | `add_script` (it overwrites) | ✅ |
| create or replace a whole tree | `write_project`, `write_entity` | ✅ |
| rename a dataset's columns | `rename_dataset_columns` | ✅ |
| anything on a standalone entity (SQL collection, ETL, DQ, catalog, mapping, preset) | — | ⛔ no tool yet |

For the last row: **say so and stop**. Do not fall back to editing the JSON — and do not
rewrite the whole tree with `write_project` to change one field either: it serializes the
spec you give it without reading what is there, so everything the spec does not model is
lost.

**Renaming and moving rewrite keys.** A widget's key is `<tab>/<slug(name)>@<y>,<x>` and a
tab's is `<parent>/<slug(name)>`, so renaming a tab re-keys its sub-tabs *and* every widget
under them, and every filter scoped to any of it. A column id is `col_<slug(name)>`, so
renaming a column re-keys it and repoints every widget config and filter that held the old
id. The tools do those cascades for you and list what changed — read that list, because
ids and keys you quoted from an earlier `describe_tree` are stale afterwards.

## Identity: three fields, one of them a trap

Every entity carries the same identity block, and getting it wrong is the single
most common way a published repo fails to install.

| Field | What it is |
|---|---|
| `entityId` | the readable, URL-safe **name** (`omop-cdm-5-4`). Set once, never changes. |
| `lineageId` | a uuid: the **identity across instances**. Two installs of the same repo are the same entity because they share it. |
| `id` | **do not write it.** It was the writing instance's local primary key. |

`id` no longer travels in an export: an importer either mints its own or keeps the
row it already has, so an authored one is silently dropped. `entityId` names the
entity; `lineageId` identifies it.

**Write a `lineageId` on anything you publish.** Without one the catalog can only
recognise an install by comparing the git URL — which breaks the moment the repo
moves host or group, when an entry declares `https://` against a local `git@`
remote, or on a fork that inherits the URL. Generate one uuid and never change it.

The manifest also declares **`type`** (`project`, `schema-preset`, …). That is what
tells a reader which kind it is, rather than the filename — every entity writes the
same `entity.json`.

**Localized fields are objects, never strings.** `name`, `description` and an
organization's `name` are `{en, fr}`. A bare string is refused by the API with a
422 before anything is written, and the validator will not warn you: it does not
check the shape of these fields.

## MCP tools

| Tool | Use |
|---|---|
| `describe_entity_schema` | fields of a spec — **read before writing** |
| `write_project` | create a whole project tree (`format: "zip"` for the import dialog) |
| `write_entity` | create a standalone entity (SQL collection, ETL pipeline, DQ rule set, data catalog, mapping project, schema preset) |
| `write_database` | create a database: metadata + `data/*.parquet` copied in + LFS — **public/synthetic data only** |
| `describe_tree` | what an existing tree holds: ids, keys, widget configs, layouts, filter scopes |
| `read_file` | one file of a tree verbatim — a script, a `.sql`, a DDL |
| `validate_entity` | check any tree; the kind is detected. Run after any change |
| `add_dashboard_tab`, `add_widget`, `add_script` | add to an existing tree |
| `update_widget` | change a widget's config (merged), dataset or plugin |
| `rename_widget`, `rename_dashboard_tab`, `move_widget` | **rekey** — the cascade is done for you and reported |
| `remove_widget`, `remove_dashboard_tab` | delete; the result names the collateral |
| `rename_dataset_columns` | **rekey** — re-derives column ids and repoints every widget config and filter |

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
| Database (Parquet + metadata) | `references/database.md` | ✅ `write_database` |
| Plugin (widget code + manifest) | `references/plugin.md` | ⚠️ files by hand |
| Cohort (inside a project) | `references/standalone-entities.md` | ⚠️ validate only |
| Patient data view | — | ❌ computed live |

Everything Linkr can export or install is listed above. The **six** ✅ `write_entity`
kinds live in their **own** folder or repo (one repo per entity, as in
`linkr-public-content`); a project holds its own datasets, dashboards and scripts and is
written with `write_project`; a database has its own tool because it copies data files.

⚠️ A **plugin** ships as code in `packages/default-plugins/`, so the MCP does not write
it — `references/plugin.md` has the procedure. A **cohort** belongs to a project and
compiles to SQL, so a wrong one returns a different population rather than failing; build
it in the app. Say so rather than hand-rolling either one's JSON.

## Databases: public or synthetic data only

A **database** repo carries its data (`data/*.parquet`), unlike anything the app
exports — the app deliberately never writes a single row, so it can never be the path by
which patient data leaves a hospital. `write_database` is allowed **because it runs
outside that context**, and that permission has one condition:

> Only ever build a database from **synthetic data or a public open dataset** (MIMIC-IV
> demo, generated data). **Never** from a connected database, a hospital extract, or any
> file you were handed without knowing its provenance.

If asked to package data whose provenance is unclear, stop and ask. A repo, once pushed,
cannot be unpublished — and a Parquet file carries no warning label saying whose it is.
Details and the licence obligations: `references/database.md`.

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
