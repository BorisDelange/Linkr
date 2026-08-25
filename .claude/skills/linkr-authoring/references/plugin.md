# Plugin

The one element the MCP does **not** write. A plugin is not part of a project tree: it
lives in `packages/default-plugins/`, is loaded by the app at build time, and ships with
the app rather than with a project. So you author its files directly — the procedure
below — and `validate_project` does not apply to it.

Complete manifest examples, every `configSchema` field type, and full Python/R
templates: **`plugin-details.md`** next to this file. Read it before writing one.

## What a plugin is

A widget the app can render, defined by a manifest plus one template per language:

```
packages/default-plugins/<analyses|patient-data>/<plugin-name>/
├── plugin.json
├── <plugin-name>.py.template
└── <plugin-name>.R.template
```

The app resolves `{{fieldName}}` placeholders in the template from the user's config,
runs the result in the project's Python or R environment, and displays what it produces.
The template is therefore a **program with holes**, not a string to concatenate.

## Two scopes, two contracts

They differ in what the code receives, and that is the decision that shapes everything
else:

- **Lab** (`analyses/`, id `linkr-analysis-<name>`) — receives `dataset`, a pandas
  DataFrame or R data.frame, already filtered by the dashboard. Operates on columns.
- **Warehouse / patient data** (`patient-data/`, id `linkr-warehouse-<name>`, and
  `"scope": "warehouse"`) — receives `person_id`, `visit_occurrence_id`,
  `visit_detail_id` and a `sql_query()` function against the active OMOP database.
  Operates on one patient.

A lab plugin cannot see patient context; a warehouse plugin has no dataset. Pick the
scope from what the widget needs to read, and do not try to bridge them.

## Getting it right

- **Never quote a placeholder.** `title = {{title}}` — the resolver adds quotes for
  strings and selects, and `"{{title}}"` produces `""My chart""`.
- **Both languages, always.** `languages: ["python", "r"]` and two templates. A missing
  R template means the widget silently fails for R users.
- **Both locales on every label**, in the manifest as everywhere else.
- Python plotting starts with `import matplotlib; matplotlib.use('Agg')` — there is no
  display attached. R uses base graphics.
- `await sql_query(...)` in Python, `sql_query(...)` without await in R.

## Testing it

There is no validator for plugins. Load the app, add the widget to a dashboard, and run
it in **both** languages — that is the only check that exists. A plugin that has never
been run should be described as untested when you hand it over.

## When asked for something that is not a plugin

A one-off chart for one dashboard is an **inline code widget** (`references/dashboard.md`),
not a plugin. A plugin is worth it when the widget is configurable and reused across
projects — it costs a manifest, two templates and a place in the shipped app.
